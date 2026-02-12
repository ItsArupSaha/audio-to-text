import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { formatTimestamp } from "./file-utils";

interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

interface TranscriptChunk {
    chunkIndex: number;
    startTimeOffset: number;
    segments: TranscriptSegment[];
}

export async function generateDocx(
    originalFilename: string,
    chunks: TranscriptChunk[]
): Promise<Blob> {
    const children: (Paragraph)[] = [];

    // Title
    children.push(
        new Paragraph({
            text: `Transcript: ${originalFilename}`,
            heading: HeadingLevel.TITLE,
            spacing: { after: 400 },
        })
    );

    // Process each chunk
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex).forEach((chunk) => {
        // Chunk Header
        const startTime = chunk.startTimeOffset;
        // Estimate end time based on last segment or chunk duration (not passed here, but segments have relative time)
        // Actually, segments from Groq might differ in time base (relative to chunk vs absolute).
        // If relative, we add offset.
        const startStr = formatTimestamp(startTime);

        children.push(
            new Paragraph({
                text: `Section starting at ${startStr}`,
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 400, after: 200 },
            })
        );

        // Combine segments into paragraphs
        // Simple approach: one paragraph per segment or combine them.
        // Let's combine them for readability, but new paragraph for each speaker change if we had speakers.
        // Since we don't have speaker diarization required, we can just list them.

        // Improving readability: group text.
        let currentText = "";
        chunk.segments.forEach((seg) => {
            // Adjust time if needed, but for DOCX text, we might just want the flow.
            // If we want timestamps in text:
            const segStart = formatTimestamp(startTime + seg.start);
            // currentText += `[${segStart}] ${seg.text} `;
            // Just text is often better for reading. Use paragraph breaks every ~5 segments.
            children.push(
                new Paragraph({
                    children: [
                        new TextRun({
                            text: `[${segStart}] `,
                            bold: true,
                            color: "888888",
                            size: 20, // 10pt
                        }),
                        new TextRun({
                            text: seg.text,
                            size: 24, // 12pt
                        })
                    ],
                    spacing: { after: 120 },
                })
            );
        });
    });

    const doc = new Document({
        sections: [
            {
                properties: {},
                children: children,
            },
        ],
    });

    return await Packer.toBlob(doc);
}
