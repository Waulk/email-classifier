import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
    EmailClassification,
    type IClassifier
} from './classifiers/classifier.ts';

class MailListener {
    private readonly MAILBOX = 'INBOX';

    private readonly REJECTION_FLAG_COLOUR = 'red' as const;
    private readonly INTERVIEW_FLAG_COLOUR = 'green' as const;

    private readonly CLASSIFICATION_BATCH_SIZE = 50 as const;
    private readonly MAX_BODY_SIZE_CHARACTERS = 8000  as const;

    private readonly client: ImapFlow;
    private readonly classifier: IClassifier;

    private lastMessageCount = 0;
    private shutdownRequested = false;
    private running = false;

    private shutdownResolver: (() => void) | null = null;

    /**
     * Serializes mailbox processing.
     *
     * EventEmitter does not await async event handlers, so multiple
     * EXISTS events could otherwise overlap.
     */
    private processingQueue: Promise<void> = Promise.resolve();

    constructor(
        client: ImapFlow,
        classifier: IClassifier
    ) {
        this.client = client;
        this.classifier = classifier;
    }

    [Symbol.dispose]() {
        this.kill();

        if (this.client.usable) {
            this.client.logout().catch((error) => {
                console.error(
                    'Error logging out from IMAP client:',
                    error
                );
            });
        }
    }

    /**
     * Requests the listener to shut down.
     */
    public kill(): void {
        if (this.shutdownRequested) {
            return;
        }

        this.shutdownRequested = true;
        this.shutdownResolver?.();
    }

    /**
     * Classifies every message that currently exists in INBOX.
     *
     * This is a one-shot operation and does not start the live listener.
     *
     * The ImapFlow client must already be connected.
     */
    public async classifyAllExistingMessages(): Promise<void> {
        if (this.running) {
            throw new Error(
                'Cannot classify existing messages while MailListener is running'
            );
        }

        if (this.shutdownRequested) {
            return;
        }

        const lock =
            await this.client.getMailboxLock(this.MAILBOX);

        try {
            if (!this.client.mailbox) {
                throw new Error(
                    `${this.MAILBOX} was not opened successfully`
                );
            }

            const messageUids =
                await this.client.search(
                    {
                        all: true
                    },
                    {
                        uid: true
                    }
                );

            if (
                !messageUids ||
                messageUids.length === 0
            ) {
                console.log(
                    `No existing messages to classify in ${this.MAILBOX}.`
                );

                return;
            }

            console.log(
                `Classifying ${messageUids.length} existing message(s) ` +
                `in ${this.MAILBOX}.`
            );

            let processedCount = 0;

            /*
             * Fetch messages in batches instead of loading the entire
             * mailbox into memory at once.
             */
            for (
                let index = 0;
                index < messageUids.length;
                index += this.CLASSIFICATION_BATCH_SIZE
            ) {
                if (this.shutdownRequested) {
                    break;
                }

                const batchUids =
                    messageUids.slice(
                        index,
                        index + this.CLASSIFICATION_BATCH_SIZE
                    );

                const messages =
                    await this.client.fetchAll(
                        batchUids.join(','),
                        {
                            uid: true,
                            source: true
                        },
                        {
                            uid: true
                        }
                    );

                for (const message of messages) {
                    if (this.shutdownRequested) {
                        break;
                    }

                    if (!message.source) {
                        continue;
                    }

                    await this.processMessage(
                        message.uid,
                        message.source
                    );

                    processedCount++;
                }

                console.log(
                    `Processed ${processedCount}/${messageUids.length} ` +
                    `existing message(s).`
                );
            }

            if (this.shutdownRequested) {
                console.log(
                    `Existing-message classification stopped after ` +
                    `${processedCount}/${messageUids.length} message(s).`
                );

                return;
            }

            console.log(
                `Finished processing ${processedCount} existing message(s).`
            );
        } finally {
            lock.release();
        }
    }

    /**
     * Starts listening for new messages.
     *
     * The ImapFlow client must already be connected.
     *
     * Messages that existed before run() starts are intentionally ignored.
     */
    public async run(): Promise<void> {
        if (this.running) {
            throw new Error(
                'MailListener is already running'
            );
        }

        if (this.shutdownRequested) {
            return;
        }

        this.running = true;

        const lock =
            await this.client.getMailboxLock(this.MAILBOX);

        const onExists = (data: {
            path: string;
            count: number;
            prevCount: number;
        }) => {
            if (this.shutdownRequested) {
                return;
            }

            if (data.path !== this.MAILBOX) {
                return;
            }

            if (data.count <= data.prevCount) {
                this.lastMessageCount = data.count;
                return;
            }

            this.queueMailboxProcessing(data.count);
        };

        const onClose = () => {
            this.shutdownResolver?.();
        };

        try {
            if (!this.client.mailbox) {
                throw new Error(
                    `${this.MAILBOX} was not opened successfully`
                );
            }

            const initialCount =
                this.client.mailbox.exists;

            this.lastMessageCount = initialCount;

            console.log(
                `Listening for new email in ${this.MAILBOX}. ` +
                `Ignoring ${initialCount} existing message(s).`
            );

            /*
             * Set the resolver before installing the close listener.
             *
             * This avoids a race where the connection closes but there
             * is not yet anything for onClose() to resolve.
             */
            const shutdownPromise =
                new Promise<void>((resolve) => {
                    this.shutdownResolver = resolve;

                    if (this.shutdownRequested) {
                        resolve();
                    }
                });

            this.client.on('exists', onExists);
            this.client.once('close', onClose);

            if (!this.client.usable) {
                this.shutdownResolver?.();
            }

            const currentCount =
                this.client.mailbox?.exists ?? initialCount;

            if (currentCount > initialCount) {
                this.queueMailboxProcessing(
                    currentCount
                );
            }

            await shutdownPromise;
            await this.processingQueue;
        } finally {
            this.client.off('exists', onExists);
            this.client.off('close', onClose);

            this.shutdownResolver = null;
            this.running = false;

            lock.release();
        }
    }

    /**
     * Adds an EXISTS update to the processing queue.
     */
    private queueMailboxProcessing(
        messageCount: number
    ): void {
        this.processingQueue = this.processingQueue
            .then(() =>
                this.handleExists(messageCount)
            )
            .catch((error) => {
                console.error(
                    'Error processing mailbox change:',
                    error
                );
            });
    }

    /**
     * Fetches and processes messages added since the previous
     * mailbox count.
     */
    private async handleExists(
        messageCount: number
    ): Promise<void> {
        if (this.shutdownRequested) {
            return;
        }

        if (messageCount <= this.lastMessageCount) {
            this.lastMessageCount = messageCount;
            return;
        }

        const firstNewMessage =
            this.lastMessageCount + 1;

        const lastNewMessage =
            messageCount;

        /*
         * These are sequence numbers, not UIDs.
         *
         * We request source:true to parse the email and uid:true so the
         * returned UID can later be used for flag operations.
         */
        const messages =
            await this.client.fetchAll(
                `${firstNewMessage}:${lastNewMessage}`,
                {
                    uid: true,
                    source: true
                }
            );

        this.lastMessageCount = messageCount;

        for (const message of messages) {
            if (this.shutdownRequested) {
                break;
            }

            if (!message.source) {
                continue;
            }

            await this.processMessage(
                message.uid,
                message.source
            );
        }
    }

    /**
     * Parses, classifies, and applies the classification for one message.
     */
    private async processMessage(
        uid: number,
        source: Buffer
    ): Promise<void> {
        try {
            const parsed =
                await simpleParser(source);

            const classification =
                await this.classifier.classifyEmail(
                    parsed.subject ?? '',
                    parsed.from?.text ?? '',
                    this.cleanEmailText(
                        parsed.text ?? ''
                    )
                );

            await this.applyClassification(
                uid,
                classification
            );
        } catch (error) {
            console.error(
                `Error processing email UID ${uid}:`,
                error
            );
        }
    }

    /**
     * Applies the appropriate flag based on the classifier result.
     */
    private async applyClassification(
        uid: number,
        classification: EmailClassification
    ): Promise<void> {
        switch (classification) {
            case EmailClassification.Rejection:
                await this.client.setFlagColor(
                    uid,
                    this.REJECTION_FLAG_COLOUR,
                    {
                        uid: true
                    }
                );
                break;

            case EmailClassification.Interview:
                await this.client.setFlagColor(
                    uid,
                    this.INTERVIEW_FLAG_COLOUR,
                    {
                        uid: true
                    }
                );
                break;

            case EmailClassification.Other:
            default:
                break;
        }
    }

    /**
     * Removes common reply history and footer noise before sending
     * the body to the classifier.
     */
    private cleanEmailText(text: string): string {
        let cleaned = text;

        // Normalize line endings.
        cleaned = cleaned.replace(/\r\n?/g, '\n');

        // Remove quoted reply lines.
        cleaned = cleaned
            .split('\n')
            .filter(
                (line) =>
                    !line.trim().startsWith('>')
            )
            .join('\n');

        /*
         * Remove common previous-message blocks.
         * Keep this conservative to avoid removing legitimate content.
         */
        const replySeparators = [
            /^On .+wrote:$/im,
            /^-{2,}\s*Original Message\s*-{2,}$/im,
            /^From:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+$/im,
            /^_{5,}$/m
        ];

        for (const separator of replySeparators) {
            const match =
                separator.exec(cleaned);

            if (match?.index !== undefined) {
                cleaned =
                    cleaned.slice(0, match.index);
            }
        }

        // Remove common unsubscribe/footer lines.
        cleaned = cleaned
            .split('\n')
            .filter((line) => {
                const normalized =
                    line.trim().toLowerCase();

                return !(
                    normalized === 'unsubscribe' ||
                    normalized.startsWith(
                        'unsubscribe from'
                    ) ||
                    normalized.startsWith(
                        'manage your email preferences'
                    ) ||
                    normalized.startsWith(
                        'manage preferences'
                    ) ||
                    normalized.startsWith(
                        'view this email in your browser'
                    )
                );
            })
            .join('\n');

        // Collapse spaces/tabs while preserving line structure.
        cleaned =
            cleaned.replace(/[ \t]+/g, ' ');

        // Collapse excessive blank lines.
        cleaned =
            cleaned.replace(/\n{3,}/g, '\n\n');

        cleaned = cleaned.trim();

        return cleaned.length > this.MAX_BODY_SIZE_CHARACTERS ? cleaned.slice(0, this.MAX_BODY_SIZE_CHARACTERS) : cleaned;
    }
}

export default MailListener;