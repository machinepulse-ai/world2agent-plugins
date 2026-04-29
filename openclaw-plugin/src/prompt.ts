import type { Attachment, W2ASignal } from "@world2agent/sdk";

export function renderSignalPrompt(
  signal: W2ASignal,
  options: {
    skillId: string;
    useSkillPrefix: boolean;
  },
): string {
  const attachmentLines = renderAttachmentLines(signal.attachments ?? []);
  const body = [
    "# World2Agent Signal",
    "",
    `Event: ${signal.event.type}`,
    signal.event.summary,
    attachmentLines ? "" : null,
    attachmentLines || null,
    "",
    "Signal JSON:",
    "```json",
    JSON.stringify(signal, null, 2),
    "```",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  if (!options.useSkillPrefix) {
    return body;
  }

  return `Use skill: ${options.skillId}\n\n${body}`;
}

function renderAttachmentLines(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";

  const lines = attachments.map((attachment) => {
    const locator = attachment.type === "reference" ? attachment.uri : "inline";
    return `- ${attachment.mime_type} ${attachment.description} (${locator})`;
  });

  return ["Attachments:", ...lines].join("\n");
}

