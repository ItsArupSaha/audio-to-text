import { NextRequest, NextResponse } from "next/server";
import { uploadToGCS } from "@/lib/gcs-helper";
import { getSpeechClient } from "@/lib/google-speech";
import { v4 as uuidv4 } from "uuid";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as Blob;
        const model = formData.get("model") as string;
        // const chunkIndex = formData.get("chunkIndex");

        if (!file) {
            return NextResponse.json({ error: "No file provided" }, { status: 400 });
        }

        // 1. Upload to GCS
        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = `audio-${uuidv4()}.mp3`;
        const gcsUri = await uploadToGCS(buffer, filename);
        console.log(`Uploaded to GCS: ${gcsUri}`);

        // 2. Submit Batch Job
        const projectId = process.env.GCP_PROJECT_ID;
        const location = "us-central1";
        // const recognizerId = "chirp-recognizer"; // We might need to create this dynamically or assume it exists/use default

        console.log(`[DEBUG] Transcribe Request: Project=${projectId}, Location=${location}, Model=chirp_2`);

        // Construct request
        // For V2 Dynamic Batch, we use BatchRecognize
        const parent = `projects/${projectId}/locations/${location}`;

        const speechClient = getSpeechClient();
        const [operation] = await speechClient.batchRecognize({
            recognizer: `${parent}/recognizers/_`, // Use default settings or simple config
            config: {
                autoDecodingConfig: {},
                languageCodes: ["bn-IN"],
                model: "chirp_2", // 'chirp_2' confirmed to work for bn-IN in us-central1 via diagnostics
                features: {
                    enableWordTimeOffsets: true,
                }
            },
            files: [{ uri: gcsUri }],
            recognitionOutputConfig: {
                inlineResponseConfig: {} // Keep result in response for simple polling, or GCS output
            },
            processingStrategy: "DYNAMIC_BATCHING"
        });

        // 3. Return Operation Name/ID for polling
        return NextResponse.json({
            status: "processing",
            operationName: operation.name,
            gcsUri
        });

    } catch (error: any) {
        console.error("Transcription Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
