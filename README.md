# betterEx

Chrome extension for Google Forms that sends question batches to a local OpenCode server.

## Usage

1. Start your OpenCode server locally on `http://127.0.0.1:4096`.
2. Load `betterEx/` as an unpacked extension in Chrome.
3. Open a Google Form.
4. Press `Alt+G` to solve the next chunk of questions.

## Notes

- Questions are processed in chunks of 12.
- The extension prefers `openai/gpt-5.4` and falls back to `github-copilot/gpt-5.3-codex`.
- It reuses a stored OpenCode session in extension storage.
- It sends Google Form image URLs to OpenCode as file parts when available.
- If your OpenCode server is password-protected, this extension will need to be updated to send auth headers.
