import React from 'react';
import { Typography } from 'antd';

/** 极简 Markdown 渲染：标题 / 列表 / 加粗（演示用） */

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <Typography.Text key={i} strong>
        {p}
      </Typography.Text>
    ) : (
      <React.Fragment key={i}>{p}</React.Fragment>
    ),
  );
}

const DocsView: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  const out: React.ReactNode[] = [];
  let listBuf: string[] = [];

  const flushList = (key: string) => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={key} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
        {listBuf.map((item, i) => (
          <li key={i} style={{ margin: '2px 0' }}>
            {renderInline(item)}
          </li>
        ))}
      </ul>,
    );
    listBuf = [];
  };

  lines.forEach((line, i) => {
    if (line.startsWith('- ')) {
      listBuf.push(line.slice(2));
      return;
    }
    flushList(`list-${i}`);
    if (line.startsWith('# ')) {
      out.push(
        <Typography.Title key={i} level={5} style={{ marginTop: 10 }}>
          {line.slice(2)}
        </Typography.Title>,
      );
    } else if (line.startsWith('## ')) {
      out.push(
        <Typography.Title key={i} level={5} style={{ marginTop: 12, fontSize: 14 }}>
          {line.slice(3)}
        </Typography.Title>,
      );
    } else if (line.trim() === '') {
      out.push(<div key={i} style={{ height: 6 }} />);
    } else {
      out.push(
        <Typography.Paragraph key={i} style={{ marginBottom: 2 }}>
          {renderInline(line)}
        </Typography.Paragraph>,
      );
    }
  });
  flushList('list-end');

  return <div style={{ fontSize: 13 }}>{out}</div>;
};

export default DocsView;
