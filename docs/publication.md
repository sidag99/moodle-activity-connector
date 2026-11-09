# Publishing the connector

## GitHub release: run your own copy

The source release is usable with local MCP clients or a personal ChatGPT connection through a Secure MCP Tunnel. Each install keeps its Moodle credentials in a local `.env` file. The optional email runner uses the same data and can be scheduled independently. This route does not require a central service to store student credentials. Each institution still controls REST availability and access.

## Plugin Directory: pilot with one institution

A directory listing with web support would be a separate hosted product. The current single-account stdio server is not safe to run as a shared service. Start with one cooperating institution and build the following before submitting:

1. **Confirm authorized access.** Agree with the institution on how each student grants read access. Integrate with the institution's supported method. Signing in through campus SSO does not, by itself, grant a Moodle REST token. If the institution approves user-issued tokens, enroll them on a separate settings page and bind each token to its account and site; do not collect tokens in chat.
2. **Build the hosted MCP service.** Serve Streamable HTTP over a stable public HTTPS endpoint. Use [MCP OAuth 2.1](https://developers.openai.com/plugins/build/auth) for ChatGPT sign-in and derive the account from the validated token on every request. Keep institution URLs on an administrator-managed allowlist; never fetch arbitrary URLs supplied by chat. Encrypt credentials, enforce per-account access and revocation, and keep secrets and course content out of logs. Test that one student's account cannot see another student's data.
3. **Verify against a test Moodle.** Compare the results with Moodle Dashboard for dated and undated assignments, submissions, course restrictions, quizzes, overrides, and exam windows. Use a dedicated reviewer account with synthetic coursework. Publish a privacy policy covering the data read, retention, deletion and disconnect behavior. Keep daily email optional with a verified recipient and controls for time zone and unsubscribe. Email need not ship in the first hosted release.
4. **Submit after the pilot.** Verify the publisher identity and endpoint domain, package the plugin, complete the automated tool checks, and submit with review instructions and test credentials. A private Secure MCP Tunnel is suitable for personal use, but [does not qualify as the public endpoint](https://developers.openai.com/plugins/build/mcp-server). See [the submission guide](https://developers.openai.com/plugins/deploy/submission).

OpenAI also documents a [desktop-only directory route](https://developers.openai.com/plugins/deploy/desktop-only), but local MCP submissions are currently limited to approved partners. Until there is an eligible publisher or a hosted service, GitHub and personal installation are the distribution path.
