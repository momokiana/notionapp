import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+|file:\/\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`") && tok.endsWith("`")) {
      out.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") && tok.endsWith("**")) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const label = tok.slice(1, tok.indexOf("]("));
      const href = m[2] ?? "";
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>,
        );
      } else {
        out.push(
          <code key={key++} title={href}>
            {label}
          </code>,
        );
      }
    } else {
      out.push(
        <a key={key++} href={tok} target="_blank" rel="noreferrer">
          {tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "text"}</span>
        <button
          type="button"
          className="mini-btn"
          style={{ background: "rgba(255,255,255,0.08)", borderColor: "transparent", color: "#d6e0f5" }}
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="code-pre">{code}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(<CodeBlock key={k++} lang={lang} code={buf.join("\n")} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push(<h3 key={k++}>{renderInline(h[2]!)}</h3>);
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={k++} style={{ border: "none", borderTop: "1px solid var(--divider)", margin: "10px 0" }} />);
      i++;
      continue;
    }
    if (line.trim().startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("> ")) {
        q.push(lines[i]!.trim().slice(2));
        i++;
      }
      blocks.push(<blockquote key={k++}>{renderInline(q.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={k++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={k++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.trim().startsWith("```") &&
      !/^#{1,3}\s+/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith("> ")
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={k++}>
        {para.map((pl, idx) => (
          <span key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(pl)}
          </span>
        ))}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
