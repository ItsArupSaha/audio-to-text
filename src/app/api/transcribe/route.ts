import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as Blob;
        const model = formData.get("model") as string;
        // const chunkIndex = formData.get("chunkIndex");

        if (!file) {
            return NextResponse.json({ error: "No file provided" }, { status: 400 });
        }

        if (!model) {
            return NextResponse.json({ error: "No model selected" }, { status: 400 });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "Server misconfigured: No API Key" }, { status: 500 });
        }

        // Convert Blob/File to File object for FormData if strictly required by Node fetch?
        // In Next.js App Router, `req.formData()` gives us standard web File/Blob.
        // We need to pass this to Groq. 
        // Groq expects multipart/form-data. we can pipe it.

        const groqFormData = new FormData();
        groqFormData.append("file", file);
        groqFormData.append("model", model);
        groqFormData.append("language", "bn"); // Bengali
        groqFormData.append("response_format", "verbose_json"); // Get segments

        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                // Do NOT set Content-Type header manually for FormData, fetch does it with boundary
            },
            body: groqFormData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Groq API Error:", response.status, errorText);

            if (response.status === 429) {
                return NextResponse.json(
                    { error: "Rate limit exceeded", code: "RATE_LIMIT_EXCEEDED" },
                    { status: 429 }
                );
            }

            if (response.status === 413) {
                return NextResponse.json(
                    { error: "File too large", code: "PAYLOAD_TOO_LARGE" },
                    { status: 413 }
                );
            }

            return NextResponse.json(
                { error: `Groq API Error: ${response.statusText}`, details: errorText },
                { status: response.status }
            );
        }

        const data = await response.json();

        // Extract rate limit headers
        const rateLimits: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            if (key.startsWith('x-ratelimit')) {
                rateLimits[key] = value;
            }
        });

        return NextResponse.json({ ...data, rateLimits });

    } catch (error) {
        console.error("Handler Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
