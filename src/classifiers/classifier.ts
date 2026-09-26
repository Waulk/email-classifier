enum EmailClassification {
    Interview = "interview",
    Rejection = "rejection",
    Other = "other",
}

interface IClassifier {
    classifyEmail(subject: string, from: string, body: string): Promise<EmailClassification>;
}


export { EmailClassification, IClassifier };