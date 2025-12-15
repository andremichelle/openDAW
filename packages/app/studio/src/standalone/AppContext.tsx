import React, { createContext, useContext, useEffect, useState } from 'react';
const { ipcRenderer } = window.require('electron');

interface AppSettings {
    projectRoot: string;
    elevenLabsKey: string;
    elevenLabsModel: string;
    elevenLabsVoice: string;
}

interface AppContextType {
    settings: AppSettings;
    updateSettings: (newSettings: Partial<AppSettings>) => void;
    currentSongPath: string | null;
    setCurrentSongPath: (path: string | null) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [settings, setSettings] = useState<AppSettings>({
        projectRoot: '',
        elevenLabsKey: '',
        elevenLabsModel: '',
        elevenLabsVoice: ''
    });
    const [currentSongPath, setCurrentSongPath] = useState<string | null>(null);

    useEffect(() => {
        ipcRenderer.invoke('get-settings').then((saved: AppSettings) => {
            setSettings(saved);
        });
    }, []);

    const updateSettings = (newSettings: Partial<AppSettings>) => {
        const updated = { ...settings, ...newSettings };
        setSettings(updated);
        ipcRenderer.invoke('save-settings', newSettings);
    };

    return (
        <AppContext.Provider value={{ settings, updateSettings, currentSongPath, setCurrentSongPath }}>
            {children}
        </AppContext.Provider>
    );
};

export const useApp = () => {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error("useApp must be used within AppProvider");
    return ctx;
};
