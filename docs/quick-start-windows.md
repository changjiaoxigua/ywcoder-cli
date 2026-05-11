# YwCoder Quick Start for Windows

This guide uses Windows PowerShell.

## 1. Install Node.js

Install Node.js 20 or newer from:

- `https://nodejs.org/`

Then open PowerShell and check it:

```powershell
node --version
npm --version
```

## 2. Install YwCoder

```powershell
npm install -g @dcywzc/ywcoder
```

## 3. Pick One Provider

### Option A: OpenAI

Replace `sk-your-key-here` with your real key.

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_MODEL="gpt-4o"

ywcoder
```

### Option B: DeepSeek

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_BASE_URL="https://api.deepseek.com/v1"
$env:OPENAI_MODEL="deepseek-chat"

ywcoder
```

### Option C: Ollama

Install Ollama first from:

- `https://ollama.com/download/windows`

Then run:

```powershell
ollama pull llama3.1:8b

$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:11434/v1"
$env:OPENAI_MODEL="llama3.1:8b"

ywcoder
```

No API key is needed for Ollama local models.

### Option D: LM Studio

Install LM Studio first from:

- `https://lmstudio.ai/`

Then in LM Studio:

1. Download a model (e.g., Llama 3.1 8B, Mistral 7B)
2. Go to the "Developer" tab
3. Select your model and enable the server via the toggle

Then run:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:1234/v1"
$env:OPENAI_MODEL="your-model-name"
# $env:OPENAI_API_KEY="lmstudio"  # optional: some users need a dummy key

ywcoder
```

Replace `your-model-name` with the model name shown in LM Studio.

No API key is needed for LM Studio local models (but uncomment the `OPENAI_API_KEY` line if you hit auth errors).

## 4. If `ywcoder` Is Not Found

Close PowerShell, open a new one, and try again:

```powershell
ywcoder
```

## 5. If Your Provider Fails

Check the basics:

### For OpenAI or DeepSeek

- make sure the key is real
- make sure you copied it fully

### For Ollama

- make sure Ollama is installed
- make sure Ollama is running
- make sure the model was pulled successfully

### For LM Studio

- make sure LM Studio is installed
- make sure LM Studio is running
- make sure the server is enabled (toggle on in the "Developer" tab)
- make sure a model is loaded in LM Studio
- make sure the model name matches what you set in `OPENAI_MODEL`

## 6. Updating YwCoder

```powershell
npm install -g @dcywzc/ywcoder@latest
```

## 7. Uninstalling YwCoder

```powershell
npm uninstall -g @dcywzc/ywcoder
```

## Frequently Asked Questions

### Q1: "YwCoder on Windows requires git-bash"

If you see this error when running `ywcoder`, it means YwCoder cannot find `bash.exe`.

YwCoder looks for git-bash in the following order:

1. Environment variable `YWCODER_GIT_BASH_PATH`.
2. Default install locations:
   - `C:\Program Files\Git\cmd\git.exe`
   - `C:\Program Files (x86)\Git\cmd\git.exe`
3. System `PATH` via `where.exe git`.

If git is found, YwCoder automatically derives `bash.exe` from it:
`C:\Program Files\Git\cmd\git.exe` → `C:\Program Files\Git\bin\bash.exe`.

**Quick check (PowerShell):**

```powershell
where.exe git
```

**Fixes:**

- If git is installed but `where.exe git` fails, add Git's `cmd` directory to your system `PATH` (e.g., `C:\Program Files\Git\cmd`), then **restart PowerShell**.
- If Git is installed in a non-default location and not on `PATH`, set the environment variable before running YwCoder:

```powershell
$env:YWCODER_GIT_BASH_PATH="C:\Program Files\Git\bin\bash.exe"
```

To make it permanent, add `YWCODER_GIT_BASH_PATH` as a system environment variable.

### Q2: "'ywcoder' is not recognized as a cmdlet" or "'node' is not recognized"

This happens when Node.js or the global npm packages directory is not in your system `PATH`.

**Quick check (PowerShell):**

```powershell
node --version
npm --version
```

If either command fails, Node.js is not in `PATH`. If `node` works but `ywcoder` does not, the global npm bin directory is missing from `PATH`.

**Fixes:**

1. Reinstall Node.js and check the option **"Add to PATH"** during installation.
2. Or manually add Node.js and the global npm directory to your system `PATH`:
   - Node.js: `C:\Program Files\nodejs`
   - Global npm bin: run `npm config get prefix` and append `\` to the result. For example, if the prefix is `C:\Users\<username>\AppData\Roaming\npm`, add that folder to `PATH`.
3. After changing `PATH`, **close and reopen PowerShell**.

## Need Advanced Setup?

Use:

- [Advanced Setup](advanced-setup.md)
