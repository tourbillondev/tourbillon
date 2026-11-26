import React from 'react';
export default function SocialSoon(){return <div className="social-soon" aria-label="Social channels coming soon">{[['X','x.svg'],['Telegram','telegram.svg']].map(([name,file])=><span className="social-soon-item" key={name}><img src={`/assets/logos/${file}`} alt=""/><span>{name}<small>Coming soon</small></span></span>)}</div>}
