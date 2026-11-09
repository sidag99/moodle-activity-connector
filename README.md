# Moodle Activity Connector

A read-only Moodle connector for ChatGPT and other MCP clients, with an optional daily email digest. It finds active assignments, quizzes and other activities that Moodle exposes, with course names, deadlines, descriptions and links. Each person runs their own copy and uses an authorized token for their own account.

This project is independent of Moodle, OpenAI and TU Darmstadt. See [the publication plan](docs/publication.md) for what a hosted directory plugin would require.

## 1. Get authorized Moodle access

Sign in to your school's Moodle and check **Preferences → Security keys**. If you don't have a key for an appropriate web service, ask your Moodle administrator for a REST token with the read permissions below. Keep your token out of chats, command-line arguments and shared files.

The [Moodle web service guide](https://docs.moodle.org/502/en/Using_web_services) explains how administrators configure REST services and issue tokens. If support asks which functions are needed, send this list:

- `core_webservice_get_site_info`
- `core_calendar_get_action_events_by_timesort`
- `core_enrol_get_users_courses`
- `core_course_get_contents`
- `mod_assign_get_submission_status`
- `mod_quiz_get_quiz_access_information`
- `mod_quiz_get_user_attempts`

TU Darmstadt runs [Moodle Exam separately](https://www.e-learning.tu-darmstadt.de/werkzeuge/e_pruefungen/leistungsumfang/index.de.jsp). For coverage on any separate exam instance, configure both `MOODLE_EXAM_URL` and an authorized `MOODLE_EXAM_TOKEN`. Leave them blank if you do not have access. The connector does not read external registration systems or exam questions.

## 2. Preview what it finds

With Node.js 22 or later, open a terminal in the cloned or extracted folder:

```sh
npm ci
umask 077
cp -n .env.example .env
chmod 600 .env
```

Open `.env` locally in your text editor and set `MOODLE_URL` to your Moodle home URL and fill in `MOODLE_TOKEN`. Include the installation path if Moodle lives in a subdirectory. For TU Darmstadt, use `https://moodle.tu-darmstadt.de/`; if authorized separately, the exam URL is `https://moodle-exam.tu-darmstadt.de/`. Then run:

```sh
npm run digest -- --preview
```

Compare the preview with your Moodle Dashboard and course pages. The preview does not send mail. If you see `invalidtoken`, verify the token and its site with support. If you see `accessexception` for a specific function, check whether your service includes that function. A partial check identifies coverage issues in the result.

## 3. Connect to ChatGPT

**ChatGPT on the web:** Use an [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) with its local stdio profile. Set the MCP command to the absolute path to this folder's `start-mcp.sh`. The launcher expects `node` on the tunnel client's PATH. The guide explains creating the tunnel, granting access, and running the tunnel client. Then follow [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server): open ChatGPT Plugins, add a custom MCP server, choose **Tunnel**, and select your tunnel. Name it **Moodle Activity Connector**, install it, and select it in a Work chat. This single-account server relies on tunnel access controls; use a private tunnel with access limited to you and do not share the plugin or expose it through a public URL. The local machine and tunnel client must be running for the web plugin to work. Availability depends on your workspace permissions and Platform tunnel access.

**ChatGPT desktop with local MCP:** In **Settings → MCP servers → Add server**, choose **STDIO**, use the absolute path to `start-mcp.sh` as the command, and restart as prompted. If the app can't find Node, set the command to the absolute path printed by `command -v node`, and pass `--env-file=/absolute/path/to/.env` and `/absolute/path/to/server.mjs` as two arguments. See [ChatGPT Learn: Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp).

Try: “Use Moodle Activity Connector to list my open activities, sorted by deadline. Show the course, what I need to do, and the link. Fetch the next page if needed and tell me if any sources were unavailable.”

## 4. Enable the daily email

Fill in the SMTP fields in `.env` with your provider's settings and set `MAIL_TO` to your own email address. Run this once when you're ready to receive the digest:

```sh
npm run digest -- --send
```

Once that works, schedule this command daily in this folder using a local scheduler, such as a Codex automation. The digest uses Europe/Berlin unless you change `DIGEST_TIMEZONE`. It does not send on days when there are no active activities. It labels partial results in the subject and uses a local receipt to avoid another send that day. If the process was interrupted during delivery, check your inbox before clearing that day's receipt in `.digest-state/` and retrying. Keep the scheduler's machine available at the scheduled time. ChatGPT does not have to be open to use the email runner independently of the connector.

## Coverage

The connector can only report work Moodle exposes to the configured account and enabled API functions. It uses Moodle's actionable Timeline for dated work and checks certain activities outside Timeline for unfinished work. It may miss work with no Timeline action, no useful completion status, a restricted exam window, or dates only announced in a PDF, message, calendar-only event, or a different service. Some activities genuinely have no Moodle deadline; the digest says so instead of guessing. Use your official course and exam pages for authoritative dates.

Run `npm test` for the fixture-based and MCP protocol checks. No live student data is used in the tests.
