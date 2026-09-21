import React, { useMemo } from 'react';
import { Button, Tooltip } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

const JsonView: React.FC<{ data: unknown }> = ({ data }) => {
  const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const copy = () => {
    void navigator.clipboard?.writeText(text);
  };
  return (
    <div style={{ position: 'relative' }}>
      <Tooltip title="复制 JSON">
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={copy}
          style={{ position: 'absolute', top: 6, right: 6, zIndex: 1 }}
        />
      </Tooltip>
      <pre className="mono json-pre">{text}</pre>
    </div>
  );
};

export default JsonView;
