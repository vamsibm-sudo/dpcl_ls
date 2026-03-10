const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const visitsFile = path.join(__dirname, 'visits.json');
const scheduleFile = path.join(__dirname, 'schedule.json');
const historyDir = path.join(__dirname, 'history');
const changelogFile = path.join(__dirname, 'changelog.json');
const ADMIN_CODE = '31020262275'; // Admin code

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Ensure history directory exists
if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
}

// Load schedule from JSON
function loadSchedule() {
    try {
        return JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
    } catch (err) {
        return [];
    }
}

function saveSchedule(schedule) {
    fs.writeFileSync(scheduleFile, JSON.stringify(schedule, null, 2));
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
        'India blues', 'Impact XI', 'Devils', 'Eagles',
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
        const umpiresAssigned = {}; // Track which teams have umpired in this round
        
        // Sort matches for consistent assignment
        roundMatches.sort((a, b) => a.id - b.id);
        
        roundMatches.forEach(match => {
            const playingTeams = new Set([match.team1, match.team2]);
            
            // Get teams that haven't umpired yet in this round
            const availableUmpires = allTeams.filter(team =>
                !playingTeams.has(team) && !umpiresAssigned[team]
            );
            
            let selectedUmpires = [];
            
            if (availableUmpires.length >= 2) {
                // Pick first 2 available teams
                selectedUmpires = availableUmpires.slice(0, 2);
            } else if (availableUmpires.length === 1) {
                // Only 1 available, need to pick from teams that already umpired
                selectedUmpires = [availableUmpires[0]];
                const alreadyUmpired = allTeams.filter(team =>
                    !playingTeams.has(team) && umpiresAssigned[team]
                );
                if (alreadyUmpired.length > 0) {
                    selectedUmpires.push(alreadyUmpired[0]);
                }
            } else {
                // No available teams, pick any 2 not playing
                const usableUmpires = allTeams.filter(team => !playingTeams.has(team));
                selectedUmpires = usableUmpires.slice(0, 2);
            }
            
            // Mark these teams as having umpired in this round
            selectedUmpires.forEach(team => {
                umpiresAssigned[team] = true;
            });
            
            // Store umpires in match
            match.umpires = selectedUmpires;
        });
    });
    
    return schedule;
}

// API endpoint for getting schedule
app.get('/api/schedule', (req, res) => {
    let schedule = loadSchedule();
    
    // Ensure umpires are assigned
    const needsUmpireAssignment = schedule.some(m => !m.umpires || m.umpires.length === 0);
    if (needsUmpireAssignment) {
        schedule = generateUmpireAssignments(schedule);
        saveSchedule(schedule);
    }
    
    res.json(schedule);
});

// API endpoint for updating a match
app.post('/api/schedule/update', (req, res) => {
    const { code, matchId, updates } = req.body;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }
    
    const schedule = loadSchedule();
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
app.post('/api/umpires/regenerate', (req, res) => {
    const { code } = req.body;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }
    
    try {
        let schedule = loadSchedule();
        
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
app.post('/api/history/revert', (req, res) => {
    const { code, filename } = req.body;
    
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'Invalid admin code' });
    }
    
    try {
        const backupPath = path.join(historyDir, filename);
        
        // Security check: ensure the file is in the history directory
        if (!backupPath.startsWith(historyDir)) {
            return res.status(400).json({ error: 'Invalid backup file' });
        }
        
        const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        
        // Save current state as a new backup before reverting
        const currentSchedule = loadSchedule();
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
