
import { v2 } from '@google-cloud/speech';

const getSpeechClient = () => {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
        throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON not set");
    }

    try {
        const credentials = JSON.parse(credentialsJson);
        return new v2.SpeechClient({
            credentials,
            apiEndpoint: "us-central1-speech.googleapis.com",
        });
    } catch (e) {
        throw new Error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON");
    }
};

export { getSpeechClient };
