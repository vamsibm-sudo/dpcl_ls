const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const visitsFile = path.join(__dirname, 'visits.json');

// Serve static files
app.use(express.static(path.join(__dirname)));

// API endpoint for visit counter
app.get('/api/visits', (req, res) => {
  try {
    let data = JSON.parse(fs.readFileSync(visitsFile, 'utf8'));
    data.count++;
    fs.writeFileSync(visitsFile, JSON.stringify(data));
    res.json(data);
  } catch (err) {
    res.json({count: 1});
  }
});

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
