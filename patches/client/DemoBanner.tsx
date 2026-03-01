import { useState, useEffect } from 'react';

function DemoBanner() {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    // Push body content down to make room for the fixed banner
    document.body.style.paddingTop = '40px';
    return () => { document.body.style.paddingTop = ''; };
  }, []);

  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/demo/status')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.expiresAt) setExpiresAt(data.expiresAt);
        })
        .catch(() => {});
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!expiresAt) return;

    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft('expired');
        return;
      }
      const mins = Math.floor(diff / 60_000);
      if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        setTimeLeft(`${hrs}h ${rem}m`);
      } else {
        setTimeLeft(`${mins}m`);
      }
    };

    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const bannerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: '40px',
    backgroundColor: '#fef3c7',
    borderBottom: '1px solid #fbbf24',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '13px',
    color: '#92400e',
    zIndex: 10000,
    gap: '4px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };

  const linkStyle: React.CSSProperties = {
    color: '#92400e',
    fontWeight: 600,
    textDecoration: 'none',
    borderBottom: '1px solid #d97706',
  };

  return (
    <div style={bannerStyle}>
      <span role="img" aria-label="demo">🎭</span>
      <span>Live demo</span>
      <span style={{ margin: '0 2px' }}>·</span>
      <span>
        Your changes are private and expire in{' '}
        <strong>{timeLeft || '…'}</strong>
      </span>
      <span style={{ margin: '0 2px' }}>·</span>
      <a
        href="https://github.com/bshandley/pliny"
        target="_blank"
        rel="noopener noreferrer"
        style={linkStyle}
      >
        Self-host Pliny →
      </a>
    </div>
  );
}

export default DemoBanner;
