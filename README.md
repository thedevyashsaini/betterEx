# betterEx

Chrome extension for Google Forms that sends question batches to a local OpenCode server.

Now also supports Moodle quiz pages.

## Usage

0. Add C:\Users\<username>\AppData\Local\OpenCode to your environment path variable 
1. Start your OpenCode server locally on `http://127.0.0.1:4096` ( `opencode-cli.exe serve` ).
2. Load `betterEx/` as an unpacked extension in Chrome.
3. Open a Google Form.
4. Press `Alt+G` to solve the next chunk of questions.

For Moodle:

1. Open a Moodle quiz attempt page.
2. Press `Alt+G` to solve all visible question blocks on the current page.
3. Move to the next page/question and press `Alt+G` again.

## Notes

- Questions are processed in chunks of 12.
- Moodle is usually one question per page, but multiple visible questions are supported.
- The extension prefers `openai/gpt-5.4` and falls back to `github-copilot/gpt-5.3-codex`.
- It reuses a stored OpenCode session in extension storage.
- It sends Google Form image URLs to OpenCode as file parts when available.
- If your OpenCode server is password-protected, this extension will need to be updated to send auth headers.
