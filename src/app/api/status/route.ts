
import { NextRequest, NextResponse } from "next/server";
import { getSpeechClient } from "@/lib/google-speech";
import { protos } from "@google-cloud/speech";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const operationName = searchParams.get("operationName");

        if (!operationName) {
            return NextResponse.json({ error: "No operationName provided" }, { status: 400 });
        }

        // Check operation status
        const speechClient = getSpeechClient();
        const [operation] = await speechClient.operationsClient.getOperation({ name: operationName } as any);

        if (!operation.done) {
            return NextResponse.json({
                status: "processing",
                progress: (operation.metadata as any)?.progressPercent || 0
            });
        }

        if (operation.error) {
            return NextResponse.json({
                status: "error",
                error: operation.error.message
            });
        }

        // Operation done — decode the BatchRecognizeResponse
        console.log("[DEBUG] Operation done. Decoding response...");
        console.log("[DEBUG] operation.response type:", typeof operation.response);
        console.log("[DEBUG] operation.response keys:", operation.response ? Object.keys(operation.response) : "null");

        let transcriptText = "";

        try {
            // The response from operationsClient.getOperation is a google.protobuf.Any
            // which may contain a `value` buffer that needs to be decoded,
            // OR the client library may have already decoded it.

            const response = operation.response as any;

            if (response) {
                console.log("[DEBUG] Response content (first 500 chars):", JSON.stringify(response).substring(0, 500));

                // Try multiple parsing strategies

                // Strategy 1: Response is already decoded as BatchRecognizeResponse
                if (response.results) {
                    console.log("[DEBUG] Strategy 1: Direct results found");
                    transcriptText = extractTranscript(response.results);
                }

                // Strategy 2: Response has a `value` buffer (packed Any proto)
                if (!transcriptText && response.value) {
                    console.log("[DEBUG] Strategy 2: Decoding from value buffer");
                    try {
                        const decoded = protos.google.cloud.speech.v2.BatchRecognizeResponse.decode(
                            response.value instanceof Uint8Array ? response.value : Buffer.from(response.value)
                        );
                        console.log("[DEBUG] Decoded response keys:", Object.keys(decoded));
                        if (decoded.results) {
                            transcriptText = extractTranscript(decoded.results as any);
                        }
                    } catch (decodeErr) {
                        console.error("[DEBUG] Proto decode failed:", decodeErr);
                    }
                }

                // Strategy 3: Try JSON parsing of the value if it's a string
                if (!transcriptText && response.value && typeof response.value === 'string') {
                    console.log("[DEBUG] Strategy 3: JSON string value");
                    try {
                        const parsed = JSON.parse(response.value);
                        if (parsed.results) {
                            transcriptText = extractTranscript(parsed.results);
                        }
                    } catch {
                        // Not JSON
                    }
                }
            }
        } catch (parseErr: any) {
            console.error("[DEBUG] Response parsing error:", parseErr.message);
        }

        if (!transcriptText) {
            console.log("[DEBUG] No transcript extracted. Returning raw for debugging.");
            return NextResponse.json({
                status: "completed",
                transcript: "",
                raw: operation, // Include for debugging
                debugMsg: "Could not extract transcript from response. Check server logs."
            });
        }

        return NextResponse.json({
            status: "completed",
            transcript: transcriptText.trim()
        });

    } catch (error: any) {
        console.error("Status Check Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/**
 * Extract transcript text from BatchRecognizeResponse results map.
 * The results is a map of { [uri]: { transcript: { results: [ { alternatives: [{ transcript }] } ] } } }
 */
function extractTranscript(results: Record<string, any>): string {
    let text = "";
    try {
        for (const key of Object.keys(results)) {
            const fileResult = results[key];
            console.log(`[DEBUG] File result key: ${key}, keys: ${Object.keys(fileResult || {})}`);

            // V2 BatchRecognizeResponse structure:
            // results[uri].transcript.results[].alternatives[].transcript
            if (fileResult?.transcript?.results) {
                for (const r of fileResult.transcript.results) {
                    if (r.alternatives && r.alternatives[0]) {
                        text += r.alternatives[0].transcript + " ";
                    }
                }
            }
            // Alternative: results[uri].inlineResult.transcript.results[].alternatives[].transcript
            else if (fileResult?.inlineResult?.transcript?.results) {
                for (const r of fileResult.inlineResult.transcript.results) {
                    if (r.alternatives && r.alternatives[0]) {
                        text += r.alternatives[0].transcript + " ";
                    }
                }
            }
            // Flat: results[uri].results[].alternatives[].transcript (no transcript wrapper)
            else if (fileResult?.results) {
                for (const r of fileResult.results) {
                    if (r.alternatives && r.alternatives[0]) {
                        text += r.alternatives[0].transcript + " ";
                    }
                }
            }
        }
    } catch (e: any) {
        console.error("[DEBUG] extractTranscript error:", e.message);
    }
    return text;
}
