
import { Storage } from '@google-cloud/storage';
import path from 'path';

// Initialize storage
// We assume GOOGLE_APPLICATION_CREDENTIALS_JSON is set in env
const getStorageClient = () => {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
        throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON not set");
    }

    try {
        const credentials = JSON.parse(credentialsJson);
        return new Storage({ credentials });
    } catch (e) {
        throw new Error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON");
    }
};

const BUCKET_NAME = process.env.GCP_BUCKET_NAME;

export async function uploadToGCS(buffer: Buffer, filename: string): Promise<string> {
    if (!BUCKET_NAME) throw new Error("GCP_BUCKET_NAME not set");

    const storage = getStorageClient();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(filename);

    await file.save(buffer);

    // Return GCS URI
    return `gs://${BUCKET_NAME}/${filename}`;
}

export async function downloadFromGCS(filename: string): Promise<string> {
    if (!BUCKET_NAME) throw new Error("GCP_BUCKET_NAME not set");

    const storage = getStorageClient();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(filename);

    const [content] = await file.download();
    return content.toString('utf-8');
}
