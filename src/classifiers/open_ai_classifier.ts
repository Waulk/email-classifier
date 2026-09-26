import { EmailClassification, IClassifier  } from "./classifier.ts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod/v4";

const EmailClassificationSchema = z.object({
    category: z.enum([
        EmailClassification.Interview,
        EmailClassification.Rejection,
        EmailClassification.Other,
    ])
});

class OpenAIClassifier implements IClassifier {
    private readonly openai: OpenAI;

    constructor(apiKey: string) {
        this.openai = new OpenAI({ apiKey });
    }

    async classifyEmail(
        subject: string,
        from: string,
        body: string
    ): Promise<EmailClassification> {
        const response = await this.openai.responses.parse({
            model: "gpt-5.6-luna",

            reasoning: {
                effort: "none",
            },

            instructions: `
You classify job application emails.

Categories:

interview:
The sender is requesting, scheduling, confirming, rescheduling,
or discussing an interview with the applicant.

rejection:
The sender indicates that the applicant was not selected,
will not continue in the hiring process, or that the
application will not proceed.

other:
Anything else, including application confirmations,
assessments, job alerts, recruiter introductions,
general correspondence, and unrelated emails.
`,

            input: `
Subject: ${subject}
From: ${from}

${body}
`,

            text: {
                format: zodTextFormat(
                    EmailClassificationSchema,
                    "email_classification"
                ),
            },
        });

        if (!response.output_parsed) {
            throw new Error("Failed to classify email");
        }

        return response.output_parsed.category;
    }
}

export { OpenAIClassifier };