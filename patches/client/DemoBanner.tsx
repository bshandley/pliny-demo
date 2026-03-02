import { useState, useEffect } from 'react';

const DEMO_CSS = `
/* Demo mode: gray out admin button */
.btn-admin {
  opacity: 0.5 !important;
  pointer-events: none !important;
  cursor: not-allowed !important;
}

/* Demo mode: disable profile edit form */
.profile-edit-section input,
.profile-edit-section button[type="submit"] {
  opacity: 0.5 !important;
  pointer-events: none !important;
}
.profile-edit-section::after {
  content: 'Profile editing is disabled in the demo';
  display: block;
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-tertiary);
  font-style: italic;
}

/* Demo mode: disable password change */
.password-section input,
.password-section button[type="submit"] {
  opacity: 0.5 !important;
  pointer-events: none !important;
}
.password-section::after {
  content: 'Password changes are disabled in the demo';
  display: block;
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-tertiary);
  font-style: italic;
}

/* Demo mode: hide API tokens section entirely */
.api-tokens-section {
  display: none !important;
}

/* Demo banner: mobile 2-line layout */
@media (max-width: 640px) {
  .demo-banner {
    height: auto !important;
    min-height: 40px;
    flex-wrap: wrap !important;
    padding: 4px 8px !important;
  }
  .demo-banner .demo-desktop-only {
    display: none !important;
  }
  .demo-banner .demo-expiry {
    width: 100%;
    text-align: center;
  }
  .demo-banner .demo-link {
    width: 100%;
    text-align: center;
  }
  body {
    padding-top: 56px !important;
  }
}
`;

function DemoBanner() {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    // Push body content down to make room for the fixed banner
    document.body.style.paddingTop = '40px';

    // Inject demo-mode CSS restrictions
    const style = document.createElement('style');
    style.setAttribute('data-demo-mode', 'true');
    style.textContent = DEMO_CSS;
    document.head.appendChild(style);

    return () => {
      document.body.style.paddingTop = '';
      style.remove();
    };
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
    <div className="demo-banner" style={bannerStyle}>
      <span className="demo-desktop-only" role="img" aria-label="demo">🎭</span>
      <span className="demo-desktop-only">Live demo</span>
      <span className="demo-desktop-only" style={{ margin: '0 2px' }}>·</span>
      <span className="demo-expiry">
        Your changes are private and expire in{' '}
        <strong>{timeLeft || '…'}</strong>
      </span>
      <span className="demo-desktop-only" style={{ margin: '0 2px' }}>·</span>
      <a
        className="demo-link"
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
