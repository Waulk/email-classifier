import { EmailClassification, IClassifier  } from "./classifier.ts";
import { OpenRouter } from "@openrouter/sdk";

class JevClassifier implements IClassifier {
    private readonly openRouter: OpenRouter;

    constructor(apiKey: string) {
        this.openRouter = new OpenRouter({ apiKey, appTitle: "JEV Email Classifier" });
    }

    async classifyEmail(
        subject: string,
        from: string,
        body: string
    ): Promise<EmailClassification> {
        const response = await this.openRouter.alpha.decisions.create({
                decisionsRequest: {
                    model: "typesafe/jev-1.13",

                    state: {
                        email: {
                            subject,
                            sender: from,
                            body,
                        },
                    },

                    questions: {
                        category: {
                            type: "choice",

                            instructions: `
            Classify the job application email in \`email\` based on its primary meaning and intent.

            Use the sender's current message as the primary evidence. Quoted prior messages,
            signatures, disclaimers, and other boilerplate should only be treated as context.
                            `.trim(),

                            criteria: {
                                interview: `
            The sender is requesting, scheduling, confirming, rescheduling, cancelling,
            or otherwise discussing an interview or hiring-process screening with the
            applicant. This includes asking the applicant to provide interview availability
            or select an interview time.
                                `.trim(),

                                rejection: `
            The sender states or clearly conveys that the applicant was not selected,
            is no longer under consideration, will not advance further in the hiring
            process, or that the application or candidacy will not proceed.
                                `.trim(),

                                other: `
            The email does not fit the interview or rejection categories. This includes
            application confirmations, assessments or coding tests, job alerts, recruiter
            introductions that do not actually arrange or discuss an interview, requests
            for additional information, offers, general correspondence, unrelated emails,
            and hiring-status updates that do not say the applicant's process has ended.
                                `.trim(),
                            },
                        },
                    },
                },
            });

        const category = response.answers.category;

        if (!category || category.type !== "choice") {
            throw new Error("Unexpected Jev response for email category");
        }

        if (category.confidence! < 0.8) {
            return EmailClassification.Other;
        }

        switch (category.choice) {
            case "interview":
                return EmailClassification.Interview;

            case "rejection":
                return EmailClassification.Rejection;

            case "other":
                return EmailClassification.Other;

            default:
                throw new Error(`Unknown email category: ${category.choice}`);
        }
    }
}

export { JevClassifier };