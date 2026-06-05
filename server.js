const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const visitsFile = path.join(__dirname, 'visits.json');
const scheduleFile = path.join(__dirname, 'schedule.json');
const historyDir = path.join(__dirname, 'history');
const changelogFile = path.join(__dirname, 'changelog.json');
const visibilityFile = path.join(__dirname, 'visibility.json');
const ADMIN_CODE = '31020262275'; // Admin code
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL ||
    'https://docs.google.com/spreadsheets/d/1E2h7NoZPrk8k7WZXEOxRnaYm4dAeKo0t/edit?usp=sharing&ouid=105805913902765284661&rtpof=true&sd=true';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID ||
    (GOOGLE_SHEET_URL.match(/\/spreadsheets\/d\/([^/]+)/) || [])[1] ||
    '1E2h7NoZPrk8k7WZXEOxRnaYm4dAeKo0t';
const GOOGLE_SHEET_GID = process.env.GOOGLE_SHEET_GID || '0';
const GOOGLE_SHEET_CSV_URLS = process.env.GOOGLE_SHEET_CSV_URL
    ? [process.env.GOOGLE_SHEET_CSV_URL]
    : [
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GOOGLE_SHEET_GID}`,
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=${GOOGLE_SHEET_GID}`,
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&single=true&gid=${GOOGLE_SHEET_GID}`,
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/pub?output=csv&gid=${GOOGLE_SHEET_GID}`
    ];
const GOOGLE_POINTS_SHEET_NAME = process.env.GOOGLE_POINTS_SHEET_NAME || 'Points';
const GOOGLE_POINTS_CSV_URLS = process.env.GOOGLE_POINTS_CSV_URL
    ? [process.env.GOOGLE_POINTS_CSV_URL]
    : [
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(GOOGLE_POINTS_SHEET_NAME)}`,
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/pub?output=csv&sheet=${encodeURIComponent(GOOGLE_POINTS_SHEET_NAME)}`
    ];
const READ_SCHEDULE_FROM_GOOGLE = process.env.READ_SCHEDULE_FROM_GOOGLE !== 'false';
const FALLBACK_TO_LOCAL_SCHEDULE = process.env.FALLBACK_TO_LOCAL_SCHEDULE === 'true';
const SCHEDULE_CACHE_MS = parseInt(process.env.SCHEDULE_CACHE_MS || '300000', 10);
const GOOGLE_SHEET_TIMEOUT_MS = parseInt(process.env.GOOGLE_SHEET_TIMEOUT_MS || '10000', 10);
let scheduleCache = { data: null, fetchedAt: 0 };
let pointsCache = { data: null, fetchedAt: 0 };
let lastGoogleSheetAttempts = [];

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Ensure history directory exists
if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
}

// Load schedule from JSON as a fallback when Google Sheets is unavailable.
function loadLocalSchedule() {
    try {
        return JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
    } catch (err) {
        return [];
    }
}

function loadVisibility() {
    try {
        const visibility = JSON.parse(fs.readFileSync(visibilityFile, 'utf8'));
        return {
            maxPublicRound: Number.isFinite(Number(visibility.maxPublicRound))
                ? Number(visibility.maxPublicRound)
                : null
        };
    } catch (err) {
        return { maxPublicRound: null };
    }
}

function saveVisibility(visibility) {
    fs.writeFileSync(visibilityFile, JSON.stringify(visibility, null, 2));
}

function filterPublicSchedule(schedule) {
    const { maxPublicRound } = loadVisibility();
    if (!Number.isFinite(maxPublicRound)) {
        return schedule;
    }
    return schedule.filter(match => Number(match.round) <= maxPublicRound);
}

function normalizeHeader(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function getValue(row, aliases) {
    for (const alias of aliases) {
        const key = normalizeHeader(alias);
        if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== '') {
            return row[key];
        }
    }
    return '';
}

function normalizeDay(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const dayMap = {
        fri: 'Friday',
        friday: 'Friday',
        sat: 'Saturday',
        saturday: 'Saturday',
        sun: 'Sunday',
        sunday: 'Sunday'
    };
    return dayMap[normalized] || String(value || '').trim();
}

function parseNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : NaN;
}

const SPECIAL_ROUND_LABELS = {
    'semifinal': 12,
    'semi final': 12,
    'semi finals': 12,
    'semis': 12,
    'final': 13,
    'finals': 13,
    'grand final': 13,
    'grand finals': 13
};

function parseRound(value) {
    const str = String(value || '').trim();
    const key = str.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (SPECIAL_ROUND_LABELS[key] !== undefined) {
        return SPECIAL_ROUND_LABELS[key];
    }
    return parseNumber(str);
}

function parseDecimal(value) {
    const match = String(value || '').match(/[+-]?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
}

function parseBoolean(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['true', 'yes', 'y', '1', 'x', 'checked', 'washout', 'washed out'].includes(normalized);
}

function parseUmpires(value) {
    return String(value || '')
        .split(/[,;/|]/)
        .map(umpire => umpire.trim())
        .filter(Boolean);
}

function parseCsv(csv) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < csv.length; i++) {
        const char = csv[i];
        const next = csv[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            row.push(field);
            field = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') {
                i++;
            }
            row.push(field);
            if (row.some(cell => String(cell).trim() !== '')) {
                rows.push(row);
            }
            row = [];
            field = '';
        } else {
            field += char;
        }
    }

    row.push(field);
    if (row.some(cell => String(cell).trim() !== '')) {
        rows.push(row);
    }

    return rows;
}

function rowMatchesAliases(row, aliases) {
    const normalizedCells = row.map(normalizeHeader);
    return aliases.some(alias => normalizedCells.includes(normalizeHeader(alias)));
}

function findScheduleHeaderIndex(rows) {
    const maxRowsToScan = Math.min(rows.length, 20);

    for (let index = 0; index < maxRowsToScan; index++) {
        const row = rows[index];
        const hasRound = rowMatchesAliases(row, ['round', 'league game', 'game']);
        const hasTime = rowMatchesAliases(row, ['time', 'slot', 'time slot', 'start time']);
        const hasGround = rowMatchesAliases(row, ['ground', 'field', 'venue', 'location']);
        const hasTeam1 = rowMatchesAliases(row, ['team1', 'team 1', 'team a', 'home', 'home team']);
        const hasTeam2 = rowMatchesAliases(row, ['team2', 'team 2', 'team b', 'away', 'away team']);
        const hasTeams = rowMatchesAliases(row, ['teams', 'match', 'fixture']);

        if (hasRound && hasTime && hasGround && ((hasTeam1 && hasTeam2) || hasTeams)) {
            return index;
        }
    }

    return 0;
}

function findPointsHeaderIndex(rows) {
    const maxRowsToScan = Math.min(rows.length, 20);

    for (let index = 0; index < maxRowsToScan; index++) {
        const row = rows[index];
        const hasTeam = rowMatchesAliases(row, ['team', 'team name', 'teamname']);
        const hasPoints = rowMatchesAliases(row, ['points', 'pts']);
        const hasNrr = rowMatchesAliases(row, ['nrr', 'net run rate', 'netrunrate']);

        if (hasTeam && hasPoints && hasNrr) {
            return index;
        }
    }

    return 0;
}

function buildRow(headers, values) {
    const row = {};
    headers.forEach((header, headerIndex) => {
        const key = normalizeHeader(header) || `column${headerIndex + 1}`;
        row[key] = String(values[headerIndex] || '').trim();
    });
    return row;
}

function parseTeams(value) {
    const match = String(value || '').split(/\s+(?:vs\.?|v\.?|versus)\s+/i);
    return match.length === 2 ? match.map(team => team.trim()) : [];
}

function sheetRowsToSchedule(csv) {
    const rows = parseCsv(csv);
    if (rows.length < 2) {
        return [];
    }

    const headerIndex = findScheduleHeaderIndex(rows);
    const headers = rows[headerIndex];

    let previousMatch = {};

    return rows.slice(headerIndex + 1)
        .map((values, index) => {
            const row = buildRow(headers, values);

            const idValue = getValue(row, ['id', 'match id', 'matchid']);
            const roundValue = getValue(row, ['round', 'league game', 'leaguegame', 'game', 'game number', 'gamenumber']);
            const teams = parseTeams(getValue(row, ['teams', 'match', 'fixture']));
            const washout = parseBoolean(getValue(row, ['washout', 'washed out', 'washedout']));
            const umpires = parseUmpires(getValue(row, ['umpires', 'umpire', 'umpire teams']));
            const match = {
                id: idValue === '' ? index : Number(idValue),
                round: parseRound(roundValue),
                day: normalizeDay(getValue(row, ['day', 'match day', 'matchday'])),
                date: getValue(row, ['date', 'match date', 'matchdate']),
                time: getValue(row, ['time', 'slot', 'timeslot', 'time slot', 'start time', 'starttime']),
                ground: getValue(row, ['ground', 'field', 'venue', 'location']),
                team1: getValue(row, ['team1', 'team 1', 'team a', 'teama', 'home', 'home team', 'hometeam']) || teams[0] || '',
                team2: getValue(row, ['team2', 'team 2', 'team b', 'teamb', 'away', 'away team', 'awayteam']) || teams[1] || '',
                team1Score: getValue(row, ['team1score', 'team 1 score', 'team a score', 'home score', 'homescore']),
                team2Score: getValue(row, ['team2score', 'team 2 score', 'team b score', 'away score', 'awayscore']),
                status: getValue(row, ['status', 'match status', 'matchstatus'])
            };

            if (!Number.isFinite(match.round) && previousMatch.round) match.round = previousMatch.round;
            if (!match.day && previousMatch.day) match.day = previousMatch.day;
            if (!match.date && previousMatch.date) match.date = previousMatch.date;
            if (!match.time && previousMatch.time) match.time = previousMatch.time;
            if (!match.ground && previousMatch.ground) match.ground = previousMatch.ground;

            const winner = getValue(row, ['winner', 'winners', 'winning team', 'winningteam']);
            const note = getValue(row, ['note', 'notes', 'reschedule note', 'reschedulenote']);

            if (winner) match.winner = winner;
            if (note) match.note = note;
            if (washout) match.washout = true;
            if (umpires.length > 0) match.umpires = umpires;
            if (Number.isFinite(match.round) || match.day || match.date || match.time || match.ground) {
                previousMatch = match;
            }

            return match;
        })
        .filter(match =>
            Number.isFinite(match.id) &&
            Number.isFinite(match.round) &&
            match.day &&
            match.time &&
            match.ground &&
            match.team1 &&
            match.team2
        )
        .sort((a, b) => a.id - b.id);
}

function sheetRowsToPoints(csv) {
    const rows = parseCsv(csv);
    if (rows.length < 2) {
        return [];
    }

    const headerIndex = findPointsHeaderIndex(rows);
    const headers = rows[headerIndex];

    return rows.slice(headerIndex + 1)
        .map(values => {
            const row = buildRow(headers, values);
            const points = getValue(row, ['points', 'pts']);
            const nrr = getValue(row, ['nrr', 'net run rate', 'netrunrate']);

            return {
                team: getValue(row, ['team', 'team name', 'teamname']),
                matches: getValue(row, ['matches', 'match', 'played', 'p']),
                win: getValue(row, ['win', 'wins', 'won', 'w']),
                lost: getValue(row, ['lost', 'loss', 'losses', 'l']),
                tied: getValue(row, ['tied', 'tie', 'ties', 't']),
                noResult: getValue(row, ['no result', 'noresult', 'nr', 'n/r']),
                points,
                nrr,
                pointsValue: parseDecimal(points),
                nrrValue: parseDecimal(nrr)
            };
        })
        .filter(row => row.team)
        .sort((a, b) => {
            const pointsDiff = (Number.isFinite(b.pointsValue) ? b.pointsValue : 0) -
                (Number.isFinite(a.pointsValue) ? a.pointsValue : 0);
            if (pointsDiff !== 0) return pointsDiff;
            return (Number.isFinite(b.nrrValue) ? b.nrrValue : 0) -
                (Number.isFinite(a.nrrValue) ? a.nrrValue : 0);
        })
        .map(({ pointsValue, nrrValue, ...row }) => row);
}

function fetchText(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const request = https.get(url, {
            headers: {
                Accept: 'text/csv,text/plain,*/*',
                'User-Agent': 'DPCL-Schedule/1.0'
            }
        }, response => {
            const { statusCode, headers } = response;

            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                response.resume();
                if (redirectCount >= 5) {
                    reject(new Error('Too many redirects while loading Google Sheet'));
                    return;
                }
                const redirectUrl = new URL(headers.location, url).toString();
                resolve(fetchText(redirectUrl, redirectCount + 1));
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Google Sheet returned HTTP ${statusCode}`));
                return;
            }

            response.setEncoding('utf8');
            let data = '';
            response.on('data', chunk => {
                data += chunk;
            });
            response.on('end', () => {
                const contentType = headers['content-type'] || '';
                if (contentType.includes('text/html') || data.trim().startsWith('<!DOCTYPE html')) {
                    reject(new Error('Google returned an HTML page instead of CSV. Confirm the sheet is shared publicly or publish it to the web.'));
                    return;
                }
                resolve(data);
            });
        });

        request.setTimeout(GOOGLE_SHEET_TIMEOUT_MS, () => {
            request.destroy(new Error(`Google Sheet request timed out after ${GOOGLE_SHEET_TIMEOUT_MS}ms`));
        });

        request.on('error', reject);
    });
}

async function fetchGoogleSheetCsv() {
    const attempts = [];

    for (const url of GOOGLE_SHEET_CSV_URLS) {
        try {
            const csv = await fetchText(url);
            attempts.push({ url, ok: true });
            lastGoogleSheetAttempts = attempts;
            return csv;
        } catch (err) {
            attempts.push({ url, ok: false, error: err.message });
        }
    }

    lastGoogleSheetAttempts = attempts;
    const details = attempts
        .map((attempt, index) => `${index + 1}. ${attempt.url} -> ${attempt.error}`)
        .join('; ');
    throw new Error(`Unable to load CSV from Google Sheets. Attempts: ${details}`);
}

async function fetchPointsSheetCsv() {
    const attempts = [];

    for (const url of GOOGLE_POINTS_CSV_URLS) {
        try {
            const csv = await fetchText(url);
            attempts.push({ url, ok: true });
            return csv;
        } catch (err) {
            attempts.push({ url, ok: false, error: err.message });
        }
    }

    const details = attempts
        .map((attempt, index) => `${index + 1}. ${attempt.url} -> ${attempt.error}`)
        .join('; ');
    throw new Error(`Unable to load Points tab CSV from Google Sheets. Attempts: ${details}`);
}

async function getGoogleSheetDiagnostics() {
    const csv = await fetchGoogleSheetCsv();
    const rows = parseCsv(csv);
    const headerIndex = findScheduleHeaderIndex(rows);
    const headers = rows[headerIndex] || [];
    const schedule = sheetRowsToSchedule(csv);

    return {
        readScheduleFromGoogle: READ_SCHEDULE_FROM_GOOGLE,
        fallbackToLocalSchedule: FALLBACK_TO_LOCAL_SCHEDULE,
        googleSheetUrl: GOOGLE_SHEET_URL,
        googleSheetCsvUrls: GOOGLE_SHEET_CSV_URLS,
        googleSheetAttempts: lastGoogleSheetAttempts,
        rowCount: Math.max(rows.length - 1, 0),
        detectedHeaderRow: headerIndex + 1,
        headers,
        sampleRows: rows.slice(0, 5),
        validScheduleRows: schedule.length,
        firstValidMatch: schedule[0] || null
    };
}

async function loadSchedule(forceRefresh = false) {
    if (!READ_SCHEDULE_FROM_GOOGLE) {
        return loadLocalSchedule();
    }

    const now = Date.now();
    if (!forceRefresh && scheduleCache.data && now - scheduleCache.fetchedAt < SCHEDULE_CACHE_MS) {
        return scheduleCache.data;
    }

    try {
        const csv = await fetchGoogleSheetCsv();
        const schedule = sheetRowsToSchedule(csv);
        if (schedule.length === 0) {
            const rows = parseCsv(csv);
            const headerIndex = findScheduleHeaderIndex(rows);
            const headers = rows[headerIndex] || [];
            throw new Error(`Google Sheet did not contain any valid schedule rows. Detected header row ${headerIndex + 1}: ${headers.join(' | ')}`);
        }
        scheduleCache = { data: schedule, fetchedAt: now };
        return schedule;
    } catch (err) {
        if (FALLBACK_TO_LOCAL_SCHEDULE) {
            console.error('Failed to load schedule from Google Sheets. Falling back to schedule.json:', err.message);
            const fallbackSchedule = loadLocalSchedule();
            scheduleCache = { data: fallbackSchedule, fetchedAt: now };
            return fallbackSchedule;
        }

        scheduleCache = { data: null, fetchedAt: 0 };
        throw err;
    }
}

async function loadPoints(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && pointsCache.data && now - pointsCache.fetchedAt < SCHEDULE_CACHE_MS) {
        return pointsCache.data;
    }

    const csv = await fetchPointsSheetCsv();
    const points = sheetRowsToPoints(csv);
    if (points.length === 0) {
        const rows = parseCsv(csv);
        const headerIndex = findPointsHeaderIndex(rows);
        const headers = rows[headerIndex] || [];
        throw new Error(`Points tab did not contain any valid rows. Detected header row ${headerIndex + 1}: ${headers.join(' | ')}`);
    }

    pointsCache = { data: points, fetchedAt: now };
    return points;
}

function saveSchedule(schedule) {
    fs.writeFileSync(scheduleFile, JSON.stringify(schedule, null, 2));
    scheduleCache = { data: schedule, fetchedAt: Date.now() };
}

// Save timestamped backup
function saveBackup(schedule) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(historyDir, `schedule_${timestamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(schedule, null, 2));
    return `schedule_${timestamp}.json`;
}

// Load changelog
function loadChangelog() {
    try {
        return JSON.parse(fs.readFileSync(changelogFile, 'utf8'));
    } catch (err) {
        return [];
    }
}

// Save changelog
function saveChangelog(changelog) {
    fs.writeFileSync(changelogFile, JSON.stringify(changelog, null, 2));
}

// Log a change to changelog
function logChange(matchId, changes, oldMatch, newMatch) {
    const changelog = loadChangelog();
    const timestamp = new Date().toISOString();
    changelog.push({
        timestamp,
        matchId,
        changes,
        oldMatch,
        newMatch
    });
    saveChangelog(changelog);
}

// Generate umpire assignments - each team umpires once per round
function generateUmpireAssignments(schedule) {
    const allTeams = [
        'Guts N Glory', 'Killer Squad Dallas', 'Mavericks', 'Royal Lions',
        'India blues', 'Impact XI', 'Impact XI', 'Devils', 'Eagles',
        'Fighters', 'JustinBoys', 'Warriors', 'DRAGONS'
    ];
    
    // Group matches by round
    const matchesByRound = {};
    schedule.forEach(match => {
        if (!matchesByRound[match.round]) {
            matchesByRound[match.round] = [];
        }
        matchesByRound[match.round].push(match);
    });
    
    // Assign umpires for each round
    Object.keys(matchesByRound).forEach(round => {
        const roundMatches = matchesByRound[round];
        const teamUmpireCount = {}; // Track umpire count for each team in this round
        
        // Initialize count to 0 for all teams
        allTeams.forEach(team => {
            teamUmpireCount[team] = 0;
        });
        
        // Sort matches for consistent assignment
        roundMatches.sort((a, b) => a.id - b.id);
        
        roundMatches.forEach(match => {
            // Handle teams as arrays
            const team1 = Array.isArray(match.team1) ? match.team1[0] : match.team1;
            const team2 = Array.isArray(match.team2) ? match.team2[0] : match.team2;
            const playingTeams = new Set([team1, team2]);
            
            // Get teams NOT playing that haven't umpired yet (count === 0)
            const availableUmpires = allTeams.filter(team =>
                !playingTeams.has(team) && teamUmpireCount[team] === 0
            );
            
            let selectedUmpires = [];
            
            if (availableUmpires.length >= 2) {
                // Pick first 2 available teams that haven't umpired yet
                selectedUmpires = availableUmpires.slice(0, 2);
            } else if (availableUmpires.length === 1) {
                // Only 1 available that hasn't umpired - need a second
                selectedUmpires = [availableUmpires[0]];
                
                // Find second team: prefer non-playing teams that haven't umpired over those that have
                const notPlaying = allTeams.filter(team =>
                    !playingTeams.has(team) && team !== selectedUmpires[0]
                );
                const notPlayingNotUmpired = notPlaying.filter(t => teamUmpireCount[t] === 0);
                
                if (notPlayingNotUmpired.length > 0) {
                    selectedUmpires.push(notPlayingNotUmpired[0]);
                } else if (notPlaying.length > 0) {
                    // Fallback: use team that has already umpired but hasn't played
                    selectedUmpires.push(notPlaying[0]);
                }
            } else {
                // No non-playing teams available without umpiring count
                // This should rarely happen in a balanced schedule
                const notPlaying = allTeams.filter(team => !playingTeams.has(team));
                const sorted = notPlaying.sort((a, b) => teamUmpireCount[a] - teamUmpireCount[b]);
                selectedUmpires = sorted.slice(0, 2);
            }
            
            // Mark these teams as having umpired in this round
            selectedUmpires.forEach(team => {
                teamUmpireCount[team]++;
            });
            
            // Store umpires in match
            match.umpires = selectedUmpires;
        });
    });
    
    return schedule;
}

// API endpoint for getting schedule
app.get('/api/schedule', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const schedule = await loadSchedule(forceRefresh);
        const isAdmin = req.query.code === ADMIN_CODE;
        res.json(isAdmin ? schedule : filterPublicSchedule(schedule));
    } catch (err) {
        console.error('Failed to load schedule from Google Sheets:', err.message);
        res.status(502).json({
            error: 'Failed to load schedule from Google Sheets',
            details: err.message
        });
    }
});

app.get('/api/schedule/debug', async (req, res) => {
    try {
        const diagnostics = await getGoogleSheetDiagnostics();
        res.type('text/plain').send([
            `readScheduleFromGoogle: ${diagnostics.readScheduleFromGoogle}`,
            `fallbackToLocalSchedule: ${diagnostics.fallbackToLocalSchedule}`,
            `googleSheetUrl: ${diagnostics.googleSheetUrl}`,
            `googleSheetCsvUrls:\n${diagnostics.googleSheetCsvUrls.map(url => `- ${url}`).join('\n')}`,
            `googleSheetAttempts:\n${diagnostics.googleSheetAttempts.map(attempt => `- ${attempt.ok ? 'OK' : 'FAILED'} ${attempt.url}${attempt.error ? ` (${attempt.error})` : ''}`).join('\n')}`,
            `rowCount: ${diagnostics.rowCount}`,
            `detectedHeaderRow: ${diagnostics.detectedHeaderRow}`,
            `headers: ${diagnostics.headers.join(' | ')}`,
            `sampleRows: ${JSON.stringify(diagnostics.sampleRows, null, 2)}`,
            `validScheduleRows: ${diagnostics.validScheduleRows}`,
            `firstValidMatch: ${JSON.stringify(diagnostics.firstValidMatch, null, 2)}`
        ].join('\n'));
    } catch (err) {
        res.status(502).type('text/plain').send([
            'Failed to load Google Sheet.',
            `Error: ${err.message}`,
            `Google Sheet URL: ${GOOGLE_SHEET_URL}`,
            `CSV URLs tried:\n${GOOGLE_SHEET_CSV_URLS.map(url => `- ${url}`).join('\n')}`,
            '',
            'Confirm the spreadsheet is shared with "Anyone with the link can view" or publish it to the web.'
        ].join('\n'));
    }
});

app.get('/api/points', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const points = await loadPoints(forceRefresh);
        res.json(points);
    } catch (err) {
        console.error('Failed to load points table from Google Sheets:', err.message);
        res.status(502).json({
            error: 'Failed to load points table from Google Sheets',
            details: err.message
        });
    }
});

app.get('/api/schedule/visibility', (req, res) => {
    const { code } = req.query;

    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }

    res.json(loadVisibility());
});

app.get('/api/schedule/public-visibility', (req, res) => {
    res.json(loadVisibility());
});

app.post('/api/schedule/visibility', (req, res) => {
    const { code, maxPublicRound } = req.body;

    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }

    const round = maxPublicRound === '' || maxPublicRound === null
        ? null
        : Number(maxPublicRound);

    if (round !== null && (!Number.isInteger(round) || round < 1)) {
        return res.status(400).json({ error: 'Invalid round selected' });
    }

    const visibility = { maxPublicRound: round };
    saveVisibility(visibility);
    res.json({ success: true, visibility });
});

// API endpoint for updating a match
app.post('/api/schedule/update', async (req, res) => {
    const { code, matchId, updates } = req.body;

    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }

    if (READ_SCHEDULE_FROM_GOOGLE) {
        return res.status(400).json({
            error: 'Schedule is managed in Google Sheets. Update the sheet, then refresh the schedule.'
        });
    }
    
    const schedule = await loadSchedule(true);
    const matchIndex = schedule.findIndex(m => m.id === matchId);
    
    if (matchIndex === -1) {
        return res.status(404).json({ error: 'Match not found' });
    }
    
    const oldMatch = schedule[matchIndex];
    
    // Save backup before making changes
    saveBackup(schedule);
    
    // Apply updates
    schedule[matchIndex] = { ...schedule[matchIndex], ...updates };
    
    // Log the change
    logChange(matchId, Object.keys(updates), oldMatch, schedule[matchIndex]);
    
    saveSchedule(schedule);
    
    res.json({ success: true, match: schedule[matchIndex] });
});

// API endpoint for verifying admin code
app.post('/api/verify-admin', (req, res) => {
    const { code } = req.body;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ authenticated: false });
    }
    
    res.json({ authenticated: true });
});

// API endpoint to regenerate umpire assignments
app.post('/api/umpires/regenerate', async (req, res) => {
    const { code } = req.body;

    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }

    if (READ_SCHEDULE_FROM_GOOGLE) {
        return res.status(400).json({
            error: 'Schedule is managed in Google Sheets. Update umpire assignments in the sheet.'
        });
    }
    
    try {
        let schedule = await loadSchedule(true);
        
        // Save current state as backup
        saveBackup(schedule);
        
        // Regenerate umpires
        schedule = generateUmpireAssignments(schedule);
        saveSchedule(schedule);
        
        // Log the action
        const changelog = loadChangelog();
        changelog.push({
            timestamp: new Date().toISOString(),
            action: 'umpires_regenerated',
            note: 'Admin regenerated umpire assignments'
        });
        saveChangelog(changelog);
        
        res.json({ success: true, message: 'Umpire assignments regenerated', schedule });
    } catch (err) {
        res.status(500).json({ error: 'Failed to regenerate umpires: ' + err.message });
    }
});

// API endpoint for getting change log
app.get('/api/history', (req, res) => {
    const { code } = req.query;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }
    
    const changelog = loadChangelog();
    res.json(changelog);
});

// API endpoint for getting list of backups
app.get('/api/history/list', (req, res) => {
    const { code } = req.query;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }
    
    try {
        const files = fs.readdirSync(historyDir)
            .filter(f => f.startsWith('schedule_') && f.endsWith('.json'))
            .sort()
            .reverse()
            .map(f => ({
                filename: f,
                timestamp: f.replace('schedule_', '').replace('.json', '')
            }));
        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

// API endpoint for reverting to a backup
app.post('/api/history/revert', async (req, res) => {
    const { code, filename } = req.body;

    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }

    if (READ_SCHEDULE_FROM_GOOGLE) {
        return res.status(400).json({
            error: 'Schedule is managed in Google Sheets. Backups can only be restored when READ_SCHEDULE_FROM_GOOGLE=false.'
        });
    }
    
    try {
        const backupPath = path.join(historyDir, filename);
        
        // Security check: ensure the file is in the history directory
        if (!backupPath.startsWith(historyDir)) {
            return res.status(400).json({ error: 'Invalid backup file' });
        }
        
        const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        
        // Save current state as a new backup before reverting
        const currentSchedule = await loadSchedule(true);
        saveBackup(currentSchedule);
        
        // Restore the backup
        saveSchedule(backupData);
        
        // Log the revert action
        const changelog = loadChangelog();
        changelog.push({
            timestamp: new Date().toISOString(),
            action: 'revert',
            revertedTo: filename,
            note: 'Admin reverted schedule to this backup'
        });
        saveChangelog(changelog);
        
        res.json({ success: true, message: `Reverted to ${filename}` });
    } catch (err) {
        res.status(400).json({ error: 'Failed to revert: ' + err.message });
    }
});

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve sponsorship.html
app.get('/sponsorship.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'sponsorship.html'));
});

// Serve admin.html
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
