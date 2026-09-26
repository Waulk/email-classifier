import { ImapFlow } from 'imapflow';

import MailListener from './mail_listener.ts';

import type { IClassifier } from './classifiers/classifier.ts';
import { JevClassifier } from './classifiers/jev_classifier.ts';
import { OpenAIClassifier } from './classifiers/open_ai_classifier.ts';

const RECONNECT_DELAY_MS = 5000;

type ClassifierName = 'jev' | 'openai';

let shutdownRequested = false;
let activeListener: MailListener | null = null;

const shutdownController = new AbortController();

function getRequiredEnvironmentVariable(
    name: string
): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(
            `Required environment variable ${name} is not set`
        );
    }

    return value;
}

function getClassifierName(): ClassifierName {
    const args = process.argv.slice(2);

    const inlineArgument = args.find(
        (argument) =>
            argument.startsWith('--classifier=')
    );

    let value: string | undefined;

    if (inlineArgument) {
        value = inlineArgument
            .slice('--classifier='.length)
            .toLowerCase();
    } else {
        const argumentIndex =
            args.indexOf('--classifier');

        if (argumentIndex !== -1) {
            value =
                args[argumentIndex + 1]?.toLowerCase();

            if (!value) {
                throw new Error(
                    'Expected a value after --classifier'
                );
            }
        }
    }

    if (!value) {
        return 'jev';
    }

    if (
        value === 'jev' ||
        value === 'openai'
    ) {
        return value;
    }

    throw new Error(
        `Unknown classifier "${value}". ` +
        'Expected "jev" or "openai".'
    );
}

function createClassifier(
    classifierName: ClassifierName
): IClassifier {
    switch (classifierName) {
        case 'jev':
            return new JevClassifier(
                getRequiredEnvironmentVariable(
                    'OPEN_ROUTER_API_KEY'
                )
            );

        case 'openai':
            return new OpenAIClassifier(
                getRequiredEnvironmentVariable(
                    'OPENAI_API_KEY'
                )
            );
    }
}

function getImapPort(): number {
    const value =
        getRequiredEnvironmentVariable(
            'IMAP_PORT'
        );

    const port = Number.parseInt(value, 10);

    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new Error(
            `Invalid IMAP_PORT: "${value}"`
        );
    }

    return port;
}

const classifierName = getClassifierName();
const classifier = createClassifier(
    classifierName
);

console.log(
    `Using classifier: ${classifierName}`
);

function createImapClient(): ImapFlow {
    const client = new ImapFlow({
        host: getRequiredEnvironmentVariable(
            'IMAP_HOST'
        ),
        port: getImapPort(),
        secure: true,
        auth: {
            user: getRequiredEnvironmentVariable(
                'IMAP_USER'
            ),
            pass: getRequiredEnvironmentVariable(
                'IMAP_PASSWORD'
            )
        },
        logger: false
    });

    /*
     * ImapFlow emits connection/socket failures through EventEmitter.
     *
     * This handler must be attached before connect() so that errors such as
     * ECONNRESET never become unhandled EventEmitter errors.
     */
    client.on('error', (error) => {
        console.error('IMAP error:', error);
    });

    return client;
}

function delay(
    ms: number,
    signal: AbortSignal
): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            signal.removeEventListener(
                'abort',
                onAbort
            );

            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };

        signal.addEventListener(
            'abort',
            onAbort,
            {
                once: true
            }
        );
    });
}

function requestShutdown(): void {
    if (shutdownRequested) {
        return;
    }

    console.log('Shutdown requested.');

    shutdownRequested = true;

    shutdownController.abort();

    activeListener?.kill();
}

process.once(
    'SIGINT',
    requestShutdown
);

process.once(
    'SIGTERM',
    requestShutdown
);

async function main(): Promise<void> {
    while (!shutdownRequested) {
        const client = createImapClient();

        const mailListener =
            new MailListener(
                client,
                classifier
            );

        activeListener = mailListener;

        try {
            console.log(
                'Connecting to IMAP server...'
            );

            await client.connect();

            console.log(
                'Connected to IMAP server.'
            );

            await mailListener.run();

            if (!shutdownRequested) {
                console.warn(
                    'IMAP connection closed. ' +
                    'Reconnection will be attempted.'
                );
            }
        } catch (error) {
            if (!shutdownRequested) {
                console.error(
                    'IMAP connection/listener error:',
                    error
                );
            }
        } finally {
            mailListener.kill();

            activeListener = null;

            if (client.usable) {
                try {
                    await client.logout();
                } catch (error) {
                    console.error(
                        'Error logging out from IMAP server:',
                        error
                    );
                }
            }
        }

        if (shutdownRequested) {
            break;
        }

        console.log(
            `Reconnecting in ` +
            `${RECONNECT_DELAY_MS / 1000} seconds...`
        );

        await delay(
            RECONNECT_DELAY_MS,
            shutdownController.signal
        );
    }

    console.log(
        'Mail listener stopped.'
    );
}

main().catch((error) => {
    console.error(
        'Fatal application error:',
        error
    );

    process.exitCode = 1;
});