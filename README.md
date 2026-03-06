# League Schedule

A simple web application to display and filter league match schedules with 12 teams across 11 rounds.

## Features

- ⚽ View all 66 matches organized by round
- 🔍 Filter by round, team, ground, or day
- 📱 Fully responsive design
- 🎨 Bright, easy-to-read interface

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and navigate to `http://localhost:3000`

## Deployment to Railway

1. **Create a GitHub repository:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/league-schedule.git
   git push -u origin main
   ```

2. **Deploy to Railway:**
   - Go to [Railway.app](https://railway.app)
   - Sign in with GitHub
   - Click "Create New Project"
   - Select "Deploy from GitHub repo"
   - Choose your `league-schedule` repository
   - Railway will automatically detect the Node.js app and deploy it
   - Your app will be live at the provided Railway URL

## Files

- `index.html` - Main HTML file with all styles and JavaScript
- `server.js` - Express server to serve the static files
- `package.json` - Node.js dependencies and scripts

## Technologies

- Node.js / Express
- Vanilla HTML, CSS, JavaScript
- No build tools required

## License

MIT
