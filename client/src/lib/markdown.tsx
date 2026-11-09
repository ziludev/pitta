import type { ReactNode } from "react";

/** Tiny markdown subset: fenced code, inline code, bold, line breaks. React escapes text. */
export function Markdown({ text }: { text: string }): ReactNode {
  const blocks = text.split(/```/);
  return (
    <>
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          const body = block.replace(/^[a-zA-Z0-9]*\n/, "");
          return (
            <pre
              key={index}
              className="my-1.5 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed"
            >
              {body}
            </pre>
          );
        }
        return <span key={index}>{inline(block)}</span>;
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\n/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key++}>{match[2]}</strong>);
    } else {
      nodes.push(<br key={key++} />);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
