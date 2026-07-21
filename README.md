# ⚡ ELDB — Magazyn Elektroniki

Lokalna aplikacja webowa do zarządzania stanem magazynowym komponentów elektronicznych.

## Wymagania

- **Node.js v22+** (używa wbudowanego `node:sqlite` — bez zewnętrznych baz danych)

## Uruchomienie

```bash
# 1. Zainstaluj zależności (tylko express + multer)
npm install

# 2. Uruchom serwer
node server.js
# → http://localhost:3000
```

> Baza danych `store.db` tworzy się automatycznie przy pierwszym uruchomieniu.

## Funkcje

| Funkcja | Opis |
|---------|------|
| **Dodaj komponent** | Nazwa, ilość, kategoria, notatki, opcjonalne zdjęcie |
| **Zdjęcia** | Upload pliku lub drag & drop, podgląd przed zapisem |
| **Kategorie** | 10 wbudowanych + dodawanie własnych z sidebar |
| **Filtr** | Kliknięcie kategorii w sidebar filtruje listę |
| **Wyszukiwarka** | Pełnotekstowe po nazwie i notatkach |
| **Sortowanie** | Data / Nazwa A-Z / Ilość ↑↓ |
| **Widok** | Siatka kart lub lista wierszami |
| **+/− ilości** | Szybka zmiana bez otwierania formularza |
| **Wskaźnik LED** | 🟢 OK / 🟡 ≤5 szt. / 🔴 brak |
| **Statystyki** | Pasek z łączną ilością, niskim stanem, brakami |

## Struktura

```
eldb/
├── server.js          ← Express API + SQLite
├── store.db           ← baza danych (auto)
├── package.json
└── public/
    ├── index.html     ← cały frontend (vanilla JS)
    └── uploads/       ← zdjęcia komponentów
```

## REST API

```
GET    /api/components?cat=&q=&sort=   lista (filtrowana)
POST   /api/components                 dodaj (multipart/form-data)
GET    /api/components/:id             szczegóły
PUT    /api/components/:id             edytuj
PATCH  /api/components/:id/qty        zmień ilość { delta: ±N }
DELETE /api/components/:id             usuń

GET    /api/categories                 lista kategorii z licznikiem
POST   /api/categories                 dodaj kategorię
DELETE /api/categories/:id             usuń kategorię

GET    /api/stats                      statystyki globalne
```
