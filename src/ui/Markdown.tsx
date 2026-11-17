import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { palette } from "./theme.js";

type MarkdownProps = {
  text: string;
  color?: string;
  dim?: boolean;
};

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <Text key={key} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Text key={key} color={palette.accent}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(
        <Text key={key} italic dimColor>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <Text key={key} color={palette.info} underline>
            {link[1]}
          </Text>,
        );
        if (link[2] !== link[1]) {
          nodes.push(
            <Text key={`${key}-url`} color={palette.faint}>
              {` ${link[2]}`}
            </Text>,
          );
        }
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A deliberately small Markdown renderer for terminal output. */
export function Markdown({ text, color = palette.text, dim = false }: MarkdownProps): React.JSX.Element {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let code: string[] | undefined;
  let codeLanguage = "";
  let key = 0;

  const pushCode = (): void => {
    if (!code) return;
    const body = code.join("\n");
    blocks.push(
      <Box
        key={`code-${key++}`}
        flexDirection="column"
        borderStyle="single"
        borderColor={palette.border}
        paddingX={1}
        marginY={0}
      >
        {codeLanguage ? (
          <Text color={palette.faint} dimColor>
            {codeLanguage}
          </Text>
        ) : null}
        <Text color={palette.text} wrap="wrap">
          {body || " "}
        </Text>
      </Box>,
    );
    code = undefined;
    codeLanguage = "";
  };

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (code) pushCode();
      else {
        code = [];
        codeLanguage = fence[1]?.trim() ?? "";
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      blocks.push(
        <Text key={`blank-${key++}`} color={palette.text}>
          {" "}
        </Text>,
      );
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(
        <Text key={`hr-${key++}`} color={palette.border}>
          {"─".repeat(48)}
        </Text>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <Box key={`h-${key++}`} marginTop={level <= 2 ? 1 : 0}>
          <Text bold color={level <= 2 ? palette.accent : palette.text}>
            {inline(heading[2]!, `h${key}`)}
          </Text>
        </Box>,
      );
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <Text key={`b-${key++}`} color={color} dimColor={dim} wrap="wrap">
          {`${bullet[1]}  `}
          <Text color={palette.accent}>• </Text>
          {inline(bullet[2]!, `b${key}`)}
        </Text>,
      );
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <Text key={`q-${key++}`} color={palette.muted} italic wrap="wrap">
          {"│ "}
          {inline(quote[1]!, `q${key}`)}
        </Text>,
      );
      continue;
    }
    blocks.push(
      <Text key={`p-${key++}`} color={color} dimColor={dim} wrap="wrap">
        {inline(line, `p${key}`)}
      </Text>,
    );
  }
  if (code) pushCode();

  return <Box flexDirection="column">{blocks}</Box>;
}
