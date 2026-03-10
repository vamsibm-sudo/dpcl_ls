const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const visitsFile = path.join(__dirname, 'visits.json');
const scheduleFile = path.join(__dirname, 'schedule.json');
const ADMIN_CODE = '31020262275'; // Admin code

app.use(express.static(path.join(__dirname)));
app.use(express.json());

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

// API endpoint for getting schedule
app.get('/api/schedule', (req, res) => {
    const schedule = loadSchedule();
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
    
    schedule[matchIndex] = { ...schedule[matchIndex], ...updates };
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
