import React from 'react';
import './components.css';

// Card: white surface container.
// Props: title? (string), action? (node rendered right of title), className?, children.
export default function Card({ title, action, className = '', children }) {
  return (
    <section className={`c-card ${className}`.trim()}>
      {(title || action) && (
        <div className="c-card-header">
          {title && <h2 className="c-card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
