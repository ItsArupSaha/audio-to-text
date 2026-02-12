import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { sanitizeFilename } from "@/lib/file-utils";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as Blob;
        const filename = formData.get("filename") as string;
        const chunkIndex = formData.get("chunkIndex") as string;

        if (!file || !filename || !chunkIndex) {
            return NextResponse.json({ error: "Missing fields" }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const safeName = sanitizeFilename(filename);

        // Define upload dir in public folder (accessible via URL if needed, but here just for storage)
        // Note: In Next.js dev, writing to public might trigger reload or be ephemeral in build.
        // Better to write to a dedicated "uploads" outside source or just in public for simplicity in local dev.
        const uploadDir = path.join(process.cwd(), "public", "uploads", safeName);

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filePath = path.join(uploadDir, `chunk_${chunkIndex}.mp3`);
        fs.writeFileSync(filePath, buffer);

        return NextResponse.json({ success: true, path: filePath });

    } catch (error) {
        console.error("Save Error:", error);
        return NextResponse.json({ error: "Failed to save chunk" }, { status: 500 });
    }
}
