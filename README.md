# Ngewa Car Wash v5 — Mfumo Kamili

## Vipya katika v5
- Scan namba ya usajili kwa kamera (OCR)
- Jina na simu ni HIARI (wateja wa haraka)
- Zulia la Nyumbani limeongezwa
- Worker assignment (NGOSHA, EMMANUEL, MICHAEL, HASSAN)
- Worker approval system (thibitisha umehudumia)
- Admin anaweza kuhariri mteja yeyote
- Dashboard ya wafanyakazi kwa admin (wateja + mapato kwa kila mtu)

## JINSI YA KUENDESHA

### 1. Tengeneza faili la .env
Nakili .env.example utengeneze .env, weka maelezo yako yote.

### 2. Firebase Service Account
- Firebase -> Settings -> Service accounts -> Generate new private key
- Weka client_email na private_key kwenye .env

### 3. Endesha locally
  npm install
  npm start
  Fungua: http://localhost:3000

## AKAUNTI ZA KUINGIA

| Mtumiaji   | Neno la Siri         | Aina        |
|-----------|----------------------|-------------|
| admin     | NgEwA@AdMiN2024      | Msimamizi   |
| NGOSHA    | ngosha123            | Mfanyakazi  |
| EMMANUEL  | emmanuel123          | Mfanyakazi  |
| MICHAEL   | michael123           | Mfanyakazi  |
| HASSAN    | hassan123            | Mfanyakazi  |

Badilisha nywila hizi kwenye .env kabla ya kutumia production!

## DEPLOY KWA RAILWAY (INTERNET)

1. Pakia code GitHub (git init, git add ., git commit, git push)
2. Railway.app -> New Project -> Deploy from GitHub
3. Weka variables zote za .env kwenye Railway Variables tab
4. Settings -> Domains -> Generate Domain
5. Shiriki URL na wafanyakazi wako!

## MFUMO WA APPROVAL

- Mteja anasajiliwa na kasasni anapangiwa mfanyakazi
- Mfanyakazi aingie kwenye akaunti yake
- Aone tab "Kazi Zangu" - ataona wateja wake wote
- Baada ya kumhudumia mteja, abonyeze "Nimehudumia - Thibitisha"
- Approval haiwezi kufutwa na mfanyakazi - admin peke yake anaweza
- Jioni, admin aone dashibodi: kila mfanyakazi amehudumia wateja wangapi na mapato yake

## SCANNER YA NAMBA

- Bonyeza "Scan Namba ya Usajili"
- Elekeza kamera kwenye namba ya gari
- Mfumo utatambua namba kiotomatiki
- Inafanya kazi vizuri zaidi kwenye simu zenye kamera nzuri
- Kama scanner haifanyi kazi, andika namba mwenyewe
