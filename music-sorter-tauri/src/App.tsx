import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/tauri'

interface Track {
  filename: string
  path: string
  genre: string
  confidence: 'high' | 'low'
  status: string
}

const translations = {
  en: {
    title: 'Your assistant for sorting music by style.',
    selectFolder: 'Select Folder',
    search: 'Search',
    filename: 'Filename',
    artist: 'Artist',
    genre: 'Detected Genre',
    status: 'Status',
    startSorting: 'Start Sorting',
    dropHere: 'Drop folder here or click to select'
  },
  ru: {
    title: 'Твой помощник в сортировке музыки по стилям.',
    selectFolder: 'Выбрать папку',
    search: 'Поиск',
    filename: 'Имя файла',
    artist: 'Исполнитель',
    genre: 'Обнаруженный жанр',
    status: 'Статус',
    startSorting: 'Начать сортировку',
    dropHere: 'Перетащите папку сюда или нажмите для выбора'
  }
}

function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [language, setLanguage] = useState<'en' | 'ru'>('en')
  const t = translations[language]

  const handleSelectFolder = useCallback(async () => {
    try {
      const path = await invoke<string>('select_folder')
      const scannedTracks = await invoke<Track[]>('scan_directory', { path })
      setTracks(scannedTracks)
    } catch (error) {
      console.error(error)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      // For simplicity, assume first file's directory
      const path = files[0].webkitRelativePath.split('/')[0]
      try {
        const scannedTracks = await invoke<Track[]>('scan_directory', { path })
        setTracks(scannedTracks)
      } catch (error) {
        console.error(error)
      }
    }
  }, [])

  const handleSort = useCallback(async () => {
    try {
      await invoke('sort_files', { tracks, outputDir: '/path/to/output' }) // Replace with actual output
      alert('Sorting completed!')
    } catch (error) {
      console.error(error)
    }
  }, [tracks])

  const filteredTracks = tracks.filter(track =>
    track.filename.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="min-h-screen bg-dark-bg text-white p-4">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <div className="flex items-center space-x-4">
          <button
            onClick={() => setLanguage(language === 'en' ? 'ru' : 'en')}
            className="px-3 py-1 bg-neon-green text-black rounded"
          >
            {language === 'en' ? 'RU' : 'EN'}
          </button>
          <input
            type="text"
            placeholder={t.search}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-1 bg-gray-700 rounded"
          />
          <button
            onClick={handleSelectFolder}
            className="px-4 py-2 bg-neon-green text-black rounded hover:bg-green-400"
          >
            {t.selectFolder}
          </button>
        </div>
      </header>

      <main>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-gray-500 p-8 text-center mb-6 cursor-pointer hover:border-neon-green"
        >
          <p className="text-xl">{t.dropHere}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="text-left p-2">{t.filename}</th>
                <th className="text-left p-2">{t.artist}</th>
                <th className="text-left p-2">{t.genre}</th>
                <th className="text-left p-2">{t.status}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTracks.map((track, index) => (
                <tr key={index} className="border-b border-gray-700">
                  <td className="p-2">{track.filename}</td>
                  <td className="p-2">Unknown</td> {/* Placeholder */}
                  <td className={`p-2 ${track.confidence === 'high' ? 'text-neon-green' : 'text-yellow-400'}`}>
                    {track.genre}
                  </td>
                  <td className="p-2">{track.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <footer className="mt-6 text-center">
        <button
          onClick={handleSort}
          className="px-6 py-3 bg-neon-green text-black text-lg font-bold rounded hover:bg-green-400"
        >
          {t.startSorting}
        </button>
      </footer>
    </div>
  )
}

export default App