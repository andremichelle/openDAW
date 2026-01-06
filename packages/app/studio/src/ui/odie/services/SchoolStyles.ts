export const OdieSchoolStyles = `
/* School 2.0 Redesign Styles */

/* Reset & Base */
.odie-school-container {
    height: 100%;
    width: 100%;
    font-family: 'Inter', sans-serif;
    color: #e2e8f0;
}

/* Layout */
.school-split-view {
    display: grid;
    grid-template-columns: 1fr 380px;
    height: 100%;
    overflow: hidden;
}

.school-library {
    background: rgba(0, 0, 0, 0.2);
    border-right: 1px solid rgba(255, 255, 255, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
}

/* Header & Nav */
.school-header-controls {
    display: flex;
    align-items: center;
    gap: 40px;
    width: 100%;
    max-width: 800px;
}

.mode-tabs {
    display: flex;
    gap: 24px;
}

.mode-btn {
    font-size: 13px;
    font-weight: 700;
    color: #64748b;
    cursor: pointer;
    padding-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
}

.mode-btn:hover {
    color: #94a3b8;
}

.mode-btn.active {
    color: white;
    border-bottom: 2px solid #3b82f6;
}

/* Search Bar */
.school-search-bar {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 8px 12px;
    color: white;
    font-size: 13px;
    width: 300px;
    outline: none;
    transition: all 0.2s;
}

.school-search-bar:focus {
    border-color: #3b82f6;
    background: rgba(0, 0, 0, 0.4);
}

/* Cards & Grid */
.school-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 20px;
    padding: 32px;
}

.school-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 20px;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
}

/* CSS HOVER EFFECT - RELIABLE */
.school-card:hover {
    background: rgba(255, 255, 255, 0.06);
    transform: translateY(-2px);
    border-color: rgba(255, 255, 255, 0.1);
}

/* Category Cards (Home) */
.cat-card {
    padding: 40px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.05);
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
}

.cat-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.2);
    transform: translateY(-2px);
}

/* Interactive Map Zones */
/* Crucial: CSS handles the hover visual, JS only handles the data/text update */
.map-zone {
    border: 1px solid rgba(255,255,255,0.1);
    transition: all 0.2s;
    cursor: pointer;
    position: relative;
    overflow: hidden;
}

.map-zone:hover {
    border-color: #60a5fa; /* Blue-400 */
    background: rgba(59, 130, 246, 0.1) !important; /* Force override inline background opacity */
    box-shadow: 0 0 15px rgba(59, 130, 246, 0.2);
    z-index: 10;
}

/* Specific Zone Colors on Hover */
.map-zone.cockpit:hover { border-color: #cbd5e1; }
.map-zone.browser:hover { border-color: #94a3b8; }
.map-zone.timeline:hover { border-color: #3b82f6; }
.map-zone.mixer:hover { border-color: #818cf8; }

/* Markdown Content */
.school-content h1 { 
    font-size: 32px; font-weight: 800; margin-bottom: 24px; letter-spacing: -0.5px;
    background: linear-gradient(to right, #fff, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.school-content h2 { 
    font-size: 20px; font-weight: 700; margin-top: 40px; margin-bottom: 16px; color: #f8fafc; 
    display: flex; align-items: center; gap: 8px;
}
.school-content p { margin-bottom: 16px; color: #cbd5e1; font-size: 16px; line-height: 1.7; }
.school-content blockquote {
    background: rgba(59, 130, 246, 0.1); border-left: 4px solid #3b82f6;
    padding: 16px 24px; border-radius: 8px; margin: 24px 0; color: #bfdbfe; font-style: italic;
}
.school-content code, .school-content pre {
    font-family: 'JetBrains Mono', monospace; font-size: 14px; color: #e2e8f0; border: 1px solid rgba(255,255,255,0.1);
}

/* EMBEDDED MENUS (Direct Navigation) */
.embedded-menu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 12px;
    z-index: 20;
}

.embedded-item {
    font-size: 11px;
    color: #94a3b8;
    padding: 6px 10px;
    background: rgba(0,0,0,0.3);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.1s;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
}

.embedded-item:hover {
    background: #3b82f6;
    color: white;
    transform: translateX(4px);
}

.embedded-folder {
    font-weight: 700;
    color: #cbd5e1;
    margin-top: 8px;
    margin-bottom: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
}
`
