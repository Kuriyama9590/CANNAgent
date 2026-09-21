import React from 'react';
import { Typography } from 'antd';
import type { DiffData } from '../types';

const DiffView: React.FC<{ data: DiffData }> = ({ data }) => {
  const lines = data.diff.split('\n');
  return (
    <div>
      <Typography.Text strong className="mono" style={{ fontSize: 13 }}>
        {data.file}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2 }}>
        {data.summary}
      </Typography.Paragraph>
      <div
        className="mono"
        style={{
          fontSize: 12,
          borderRadius: 6,
          overflow: 'hidden',
          border: '1px solid rgba(128,138,157,0.25)',
        }}
      >
        {lines.map((line, i) => {
          let cls = 'diff-row';
          if (line.startsWith('+')) cls += ' diff-add';
          else if (line.startsWith('-')) cls += ' diff-del';
          else if (line.startsWith('@')) cls += ' diff-hunk';
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DiffView;
