# Team Consistency Bot

Free, 24/7 daily accountability for the whole team — runs on GitHub Actions, no server.

- Reps tap **Start** on the Telegram bot once → auto-registered.
- Each day: the bot asks every rep their check-in, nudges hourly if quiet, gives up after 12h.
- Reply **"yes"** → personalized team-culture win.
- The **manager** gets an instant alert when someone joins, a daily digest of who checked in,
  and can text `/roster` or `/digest` anytime.

## Settings
- Non-secret config lives in `.github/workflows/bot.yml` (`MANAGER_CHAT_ID`, `TEAM_NAME`,
  `ASK_HOUR`, `DIGEST_HOUR`, timezone, check-in link).
- Secrets (in repo Settings → Secrets and variables → Actions): `TELEGRAM_BOT_TOKEN`,
  `GEMINI_API_KEY`, optional `ANTHROPIC_API_KEY`.

## Ownership / handoff
Public repo, no secrets in code. To transfer: move to a GitHub Org (add co-owners) or
Settings → Transfer; re-add the two secrets after a transfer. See the team playbook for the
full handoff checklist.
