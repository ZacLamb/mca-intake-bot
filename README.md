# MCA Intake Bot

A GHL conversation bot with **one job**: get the merchant's **funding application** and **bank statements**.
It learns from your sub-account's past conversations (what got merchants to send statements) and keeps learning every night, including from the edits you make to its drafts.

## Multiple GHL accounts

The bot connects to as many sub-accounts as you configure (`GHL_API_KEY`/`GHL_LOCATION_ID`, then `_2`, `_3`…).
- **Learning** reads conversations from **all** accounts and builds **one shared playbook**.
- **Replies** go out through the account the merchant texted. Each account uses its own token, business name, app link and field mapping. The webhook tells the accounts apart by the `location.id` GHL sends; you can add `&account=2` to the URL as a fallback.
- The dashboard has an ON/OFF switch per account, so one account can be learn-only.

## How it works

```
Merchant texts → GHL workflow "Customer Replied" → Webhook → this app
   → waits ~25s (merchant may send more) → reads the conversation + learned playbook
   → Claude writes the reply + pulls out application answers
   → DRAFT mode: reply waits in /admin for you to approve or edit
   → AUTO mode: reply sent through GHL right away
   → writes answers into contact fields, files statements, tags the contact
```

**Learning (nightly at 3am, or the button in /admin):**
1. Pulls conversations from the sub-account (last 180 days the first time, then only new ones).
2. A conversation counts as a **win** when the merchant sent a file (statement) or the contact has one of your `WIN_TAGS`.
3. Claude studies the wins, plus a sample of conversations that went cold, and writes a **playbook** (openers, how to ask for statements, objection → response, what kills deals).
4. Your draft edits and rejections go in as top-priority corrections.
5. The playbook is versioned, so you can see every version at `/admin/playbook`.

Transcripts are anonymized before Claude sees them (SSNs, EINs, card/account numbers, emails, phones and links are stripped). The bot never collects SSN, DOB, EIN, a signature or bank numbers in chat. Those go through your secure application link only.

**Guardrails built in:** no rates, approvals or terms. It steers off-topic chats back, says it's an automated assistant if asked, and stops on STOP words. It hands off to a person (tag `bot-handoff`) when a merchant is upset, asks for a human, mentions an attorney or keeps asking about pricing. It stays out of a conversation for 24h when a rep texts the merchant manually. Kill switch: tag `bot-off` on a contact, or the ON/OFF button in the dashboard.

## Merchant flow

- The bot offers a choice: **answer questions in chat** or **fill out the online app** (`APP_LINK_URL`).
- Chat path: it collects business name, address, start date, industry, owner name/email, monthly revenue, amount requested and open positions. Then it sends the secure link for SSN/DOB/signature.
- Statements: it asks for the last `STATEMENTS_REQUIRED` months and counts each file the merchant texts or emails in.
- When the required fields are in → tag `app-received` + a note with all answers on the contact.
- When enough statements are in → tag `statements-received`.
- Once both are done it thanks the merchant and goes quiet. **Hook your existing GHL workflows to those two tags** (Survey-to-App PDF, pipeline move, notify rep, lender submission).

---

## Setup (browser only: GitHub + Railway + GHL)

### 1. GitHub
Create a new private repo (e.g. `mca-intake-bot`) and upload every file in this folder (drag-and-drop the unzipped folder into "Add file → Upload files").

### 2. Railway
1. New Project → Deploy from GitHub repo → pick `mca-intake-bot`.
2. In the same project: **+ New → Database → PostgreSQL**.
3. On the bot service → **Variables** → add the ones below. `DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}`.
4. Settings → Networking → **Generate Domain**.

| Variable | Required | What |
|---|---|---|
| `GHL_API_KEY` | ✅ | **Account 1** Private Integration token (Settings → Private Integrations). Scopes: conversations (read/write), conversations/message (read/write), contacts (read/write), locations/customFields (read), forms (write, if uploading statements to a field) |
| `GHL_LOCATION_ID` | ✅ | Account 1 location ID |
| `ACCOUNT_NAME` | | Label for account 1 in the dashboard |
| `GHL_API_KEY_2` / `GHL_LOCATION_ID_2` | | **Account 2**: same as above for the second sub-account. Add `_3`, `_4`… for more |
| `ACCOUNT_NAME_2`, `BUSINESS_NAME_2`, `APP_LINK_URL_2`, `FIELD_MAP_2`, `STATEMENT_FILE_FIELD_ID_2`, `APP_SUBMITTED_TAG_2`, `WIN_TAGS_2` | | Per-account overrides. Anything left unset falls back to the un-suffixed value (except field maps/IDs, which are per account) |
| `ANTHROPIC_API_KEY` | ✅ | Your Claude API key |
| `DATABASE_URL` | ✅ | `${{Postgres.DATABASE_URL}}` |
| `WEBHOOK_SECRET` | ✅ | Any long random string |
| `ADMIN_PASSWORD` | ✅ | Password for `/admin` (any username) |
| `BUSINESS_NAME` | | e.g. `Prestige Funding` |
| `BOT_NAME` | | Name the bot uses, default `Alex` |
| `APP_LINK_URL` | | Your online application / GHL survey link |
| `STATEMENT_UPLOAD_URL` | | Optional upload page for statements |
| `STATEMENTS_REQUIRED` | | Default `4` |
| `BOT_MODE` | | `draft` (default) or `auto`; can also be switched in the dashboard |
| `ENGAGE_TAG` | | **Recommended for launch.** If set (e.g. `bot-on`), the bot ONLY talks to contacts with this tag |
| `APP_SUBMITTED_TAG` | | Tag your online-app workflow adds on submit, so the bot knows the link path is done |
| `WIN_TAGS` | | Comma list of tags that mark past wins for learning, e.g. `app received,submitted,funded` |
| `FIELD_MAP` | | JSON mapping bot answers → your custom field IDs (see step 4) |
| `STATEMENT_FILE_FIELD_ID` | | File-upload custom field to put statements in |
| `REPLY_DELAY_SECONDS` | | Default `25` |
| `HUMAN_PAUSE_HOURS` | | Default `24` |
| `CLAUDE_MODEL` | | Default `claude-sonnet-5-5` |
| `MINE_DAYS_BACK` | | History to learn from on first run, default `180` |
| `MINE_CRON` / `CRON_TZ` | | Default `0 3 * * *` / `America/New_York` |

### 3. GHL workflow (sub-account)
**Workflow 1: Bot replies**
- Trigger: **Customer Replied** (filter by channel = SMS etc. if you want; add a filter on tag `bot-on` if you use `ENGAGE_TAG`).
- Action: **Webhook** → Method POST → URL `https://YOUR-APP.up.railway.app/webhook/inbound?secret=YOUR_WEBHOOK_SECRET`.
- Allow re-entry: **ON**.

**Workflow 2 (optional): Bot sends the first text to new leads**
- Trigger: your new-lead trigger (form submitted, FB lead, tag added…).
- Action: Webhook → POST `https://YOUR-APP.up.railway.app/webhook/start?secret=YOUR_WEBHOOK_SECRET`.

### 4. Map fields
Open `https://YOUR-APP.up.railway.app/admin/fields`. It lists every custom field with its ID. Put the matches into `FIELD_MAP`, for example:
```json
{"business_address":"AbC123","business_start_date":"DeF456","industry":"GhI789","monthly_revenue":"JkL012","amount_requested":"MnO345","open_positions":"PqR678","dba":"StU901","entity_type":"VwX234","ownership_pct":"YzA567","use_of_funds":"BcD890"}
```
Business name, first/last name and email go to the standard contact fields automatically.

### 5. Teach it, then launch
1. Open `/admin` → **Learn from new conversations**. The first run can take several minutes on a big account. Check `/admin/playbook` afterwards.
2. Tag a few test contacts `bot-on` and text in from your own phone.
3. Approve or edit drafts in `/admin` for a week. Every edit teaches it.
4. When the drafts look right, flip **Mode → AUTO**.

## Tests
```
npm test                                   # redaction
DATABASE_URL=postgres://... node test/flow.test.js   # full flow with GHL + Claude mocked (scratch DB)
```
