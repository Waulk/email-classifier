# Job Email Classifier

A small TypeScript service that monitors an IMAP inbox and classifies new job application emails as **interviews**, **rejections**, or **other**.

Interview emails receive a green flag, rejection emails receive a red flag, and other messages are left unchanged.

## Features

- Monitors an IMAP inbox for new email
- Classifies job application emails using Jev or OpenAI
- Jev via OpenRouter is the default classifier
- Applies green flags to interviews and red flags to rejections
- Cleans reply history and common email footer noise before classification
- Automatically reconnects after IMAP connection failures
- Supports graceful shutdown

## Requirements

- Node.js 20.19+
- An IMAP-enabled email account
- An OpenRouter API key for Jev, or an OpenAI API key when using the OpenAI classifier

## Setup

```bash
git clone https://github.com/Waulk/email-classifier.git
cd email-classifier
npm ci
```

Copy `.env.example` to `.env` and configure:

```dotenv
OPEN_ROUTER_API_KEY=
OPENAI_API_KEY=

IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=user@example.com
IMAP_PASSWORD=
```

Only `OPEN_ROUTER_API_KEY` is required for the default classifier. `OPENAI_API_KEY` is required when using `--classifier=openai`.

## Usage

Jev is used by default:

```bash
npm start
```

Select a classifier explicitly:

```bash
npm start -- --classifier=jev
npm start -- --classifier=openai
```

Type-check the project with:

```bash
npm run typecheck
```

Only emails received after the application starts are automatically classified.

## Privacy

Email subjects, senders, and cleaned message bodies are sent to the selected external AI provider for classification. Do not use this project with emails you are not comfortable sending to that provider.