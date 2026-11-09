# Publish Moodle Activity Connector in ChatGPT and Claude

## Where the project stands

The GitHub release is a local, single-account MCP server. It supports a Moodle Security key or browser-based Moodle mobile sign-in on compatible sites. TU Darmstadt's main site was tested successfully with the mobile handoff. This does not establish that other institutions allow the flow, or that the local implementation is eligible for either public directory.

## One hosted server, two Moodle sign-in paths

Use one stable HTTPS origin under the publisher's control, with a Streamable HTTP endpoint such as `https://<your-domain>/mcp`. Use a dedicated test Moodle with synthetic coursework for reviewer access. Pilot real connections with an institution that agrees to the integration. Confirm the authorized API access with each institution and limit the launch to institutions the service is authorized to support. Anthropic's [review checklist](https://claude.com/docs/connectors/building/review-criteria#api-ownership) requires first-party APIs or APIs you legitimately proxy; disclose that Moodle is a third-party upstream and confirm eligibility before submission.

- **ChatGPT or Claude → hosted connector:** Each user authorizes the connector through standards-compliant MCP OAuth. Use an established OAuth provider with authorization code + PKCE, resource audience binding, HTTPS metadata, registered client redirect URIs and short-lived tokens. The server resolves its own account from the verified token on every request. The two products can use the same endpoint and have separate OAuth client registrations.
- **Hosted connector → Moodle, security key:** The user selects their institution and enters an authorized web service key on the connector's own settings page. Verify the Moodle account and Timeline access before enabling the connection. Never collect tokens through chat or tool inputs.
- **Hosted connector → Moodle, mobile/SSO:** Where approved, arrange an institution-supported sign-in and credential handoff. The stock Moodle mobile flow returns a custom app-scheme callback; it is not the same as MCP OAuth. Prefer an institution-supported browser integration for the hosted product. If a desktop companion is needed, use a publisher-controlled callback bound to a short-lived, one-time linking session; validate the campus and account before uploading only the approved web service credential. Get both directories' guidance before shipping a mandatory helper. Do not use shared student tokens, collect SSO passwords/cookies, or proxy arbitrary Moodle URLs. If the institution forces a different callback or denies access, provide a clear unsupported-site message.

Encrypt Moodle credentials at rest, restrict outgoing calls to configured institutions, and separate credentials and results by account. Do not log credentials or course content. Provide disconnect and deletion controls, explain what gets sent to ChatGPT or Claude, and handle revoked or expired tokens by requesting reconnection. Add tests for cross-account access, credential revocation, redirects, and both enrollment paths. Keep the daily email scheduler separate from the directory connector; the first release only needs read access.

## Submit the same endpoint to both directories

1. **ChatGPT:** Verify the publisher identity and control of the domain. Add the hosted service as a custom MCP server and test it. Prepare the plugin ZIP, including the manifest and a remote MCP configuration that declares OAuth. In [OpenAI Platform → Plugins](https://platform.openai.com/plugins), upload using the remote MCP route, verify the endpoint domain, connect OAuth, complete automated checks, and provide a synthetic test account and review instructions. Submit for review and publish when approved. See [OpenAI submission instructions](https://developers.openai.com/plugins/deploy/submission). A private Secure MCP Tunnel is for personal use; it does not qualify for the public remote listing.
2. **Claude:** Add the HTTPS endpoint as a custom connector and test every tool. From a paid Claude plan, open [Claude's developer portal](https://claude.ai/directory/manage) and select **Submit new → MCP connector**. Enter the endpoint, OAuth setup, documentation and privacy-policy URLs, support contact, icon, use cases and synthetic reviewer credentials. Disclose the upstream API and permission basis. Follow the [Claude connector submission guide](https://claude.com/docs/connectors/building/submission). A local stdio server is not accepted as a standalone connector listing.

Suggested listing name: **Moodle Activity Connector**. One-line description: **Find open Moodle assignments and quizzes, with deadlines and direct links.** Do not imply affiliation with Moodle or any institution. Example review prompts:

- “List my open Moodle assignments and quizzes, sorted by deadline.”
- “What Moodle work is due this week? Include course names and links.”
- “Which open activities have no listed deadline? Group them by course.”

Before either submission, verify that these prompts work against the hosted endpoint with a dedicated reviewer account. Prepare a policy describing the deployed service's actual data handling and a support address you control.
