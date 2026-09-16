import React, { useEffect, useState } from 'react';
import {
  App as AntdApp,
  ConfigProvider,
  Layout,
  Switch,
  Tag,
  Typography,
  theme as antdTheme,
} from 'antd';
import { MoonFilled, SunFilled } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { SimProvider } from './engine/store';
import { ThemeCtx } from './theme';
import Dashboard from './pages/Dashboard';
import RunDetail from './pages/RunDetail';

type Route = { page: 'dashboard' } | { page: 'run'; id: string };

const parseHash = (): Route => {
  const h = window.location.hash.replace(/^#/, '');
  const m = h.match(/^\/run\/(.+)$/);
  return m ? { page: 'run', id: decodeURIComponent(m[1]) } : { page: 'dashboard' };
};

const Shell: React.FC = () => {
  const [dark, setDark] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('cann-demo-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const toggle = (v: boolean) => {
    setDark(v);
    window.localStorage.setItem('cann-demo-theme', v ? 'dark' : 'light');
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 7 },
      }}
    >
      <ThemeCtx.Provider value={dark}>
        <AntdApp>
          <Layout style={{ minHeight: '100%' }}>
            <Layout.Header
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 20px',
                height: 56,
                lineHeight: '56px',
                borderBottom: '1px solid rgba(128,138,157,0.2)',
              }}
            >
              <span style={{ fontSize: 20 }}>🧠</span>
              <Typography.Title level={5} style={{ margin: 0 }}>
                CannAgent 控制台
              </Typography.Title>
              <Tag color="geekblue">昇腾算子优化 Agent</Tag>
              <Tag>模拟演示环境</Tag>
              <div style={{ flex: 1 }} />
              <Switch
                checkedChildren={<MoonFilled />}
                unCheckedChildren={<SunFilled />}
                checked={dark}
                onChange={toggle}
              />
            </Layout.Header>
            <Layout.Content style={{ padding: 16, minHeight: 'calc(100vh - 56px)' }}>
              {route.page === 'dashboard' ? <Dashboard /> : <RunDetail id={route.id} />}
            </Layout.Content>
          </Layout>
        </AntdApp>
      </ThemeCtx.Provider>
    </ConfigProvider>
  );
};

const App: React.FC = () => (
  <SimProvider>
    <Shell />
  </SimProvider>
);

export default App;
