import React, { useEffect, useState } from 'react';
import {
  App as AntdApp,
  ConfigProvider,
  Layout,
  Switch,
  Typography,
  theme as antdTheme,
} from 'antd';
import { MoonFilled, SunFilled } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { SimProvider } from './engine/store';
import { ThemeCtx, ACCENT } from './theme';
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
        token: {
          borderRadius: 6,
          colorPrimary: ACCENT,
          colorInfo: ACCENT,
          ...(dark
            ? {
                colorBgBase: '#0b0e13',
                colorBgContainer: '#12161d',
                colorBgElevated: '#171c25',
                colorBorderSecondary: 'rgba(148,163,184,0.14)',
                colorTextSecondary: '#a8b3c4',
                colorTextTertiary: '#8593a6',
              }
            : {}),
        },
      }}
    >
      <ThemeCtx.Provider value={dark}>
        <AntdApp>
          <Layout
            style={{
              minHeight: '100%',
              color: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)',
            }}
          >
            <Layout.Header
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '0 22px',
                height: 52,
                lineHeight: '52px',
                background: 'transparent',
                borderBottom: '1px solid rgba(148,163,184,0.16)',
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.04em' }}
              >
                CannAgent
              </span>
              <span style={{ width: 1, height: 14, background: 'rgba(148,163,184,0.32)' }} />
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                昇腾算子优化 · 控制台
              </Typography.Text>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  border: '1px solid rgba(148,163,184,0.35)',
                  borderRadius: 4,
                  color: 'rgba(148,163,184,0.85)',
                  letterSpacing: '0.14em',
                }}
              >
                LIVE
              </span>
              <div style={{ flex: 1 }} />
              <Switch
                size="small"
                checkedChildren={<MoonFilled />}
                unCheckedChildren={<SunFilled />}
                checked={dark}
                onChange={toggle}
              />
            </Layout.Header>
            <Layout.Content style={{ padding: '18px 22px', minHeight: 'calc(100vh - 52px)' }}>
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
