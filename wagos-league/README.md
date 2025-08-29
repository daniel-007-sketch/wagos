## Wagos League

Express + SQLite app with weekly team randomization (A, B, C), player signup, team view, admin login and manual reset, Tailwind UI, and countdown to next Wednesday.

### Local development

1. Install deps
```
npm install
```
2. Run the server
```
npm run start
```
3. Open http://localhost:3000

Admin login: user `admin`, pass `admin123`.

Environment variables:
- `PORT` default 3000
- `SESSION_SECRET` set a strong secret in production
- `DATABASE_PATH` SQLite file path (default `./data.sqlite`)

### Render deployment (recommended)

1. Push this repo to GitHub
2. Add `render.yaml` to the repo root (already included)
3. In Render, New + → Blueprint, select your repo
4. Render provisions a web service with persistent disk at `/var/data` for SQLite
5. App will be available at your Render URL

### Docker

Build and run:
```
docker build -t wagos-league .
docker run -p 3000:3000 -e SESSION_SECRET=change-me wagos-league
```

### Heroku

Use the included `Procfile` and set `SESSION_SECRET`. Heroku’s ephemeral disk means SQLite won’t persist across restarts; use a hosted DB if persistence is required.

