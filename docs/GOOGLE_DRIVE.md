# Google Drive setup (approved payroll PDFs)

After payroll is run, Admin → Hours **Finalized** writes that pay period’s Hours PDF (same report, **APPROVED AND FINAL** watermark) into a Drive folder named **911 Approved Payroll**.

The server needs Drive API access. Use a Workspace service account (preferred) or a one-time OAuth refresh token.

## 1. Enable the Drive API

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Pick the same project you use for Google admin sign-in.
3. **APIs & Services → Library** → **Google Drive API** → **Enable**.

## 2. Service account (recommended)

1. **APIs & Services → Credentials → Create credentials → Service account**.
2. Name it something like `c911-payroll-archive`.
3. Open the account → **Keys → Add key → JSON** and download the file.
4. In Google Drive, create (or pick) a folder named **911 Approved Payroll**.
5. Share that folder with the service account email (`...@....iam.gserviceaccount.com`) as **Editor**.
6. Set these on the server (Vercel → Settings → Environment Variables):

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_DRIVE_FOLDER_ID=the-folder-id-from-the-Drive-url
```

`GOOGLE_DRIVE_FOLDER_ID` is optional. If it is unset, the app looks up a folder named **911 Approved Payroll** and creates one in the service account’s Drive if none exists (then share that created folder with payroll).

Paste the JSON as a single line. Do not commit the key file.

## 3. OAuth refresh token (alternative)

If you already have an OAuth client for Workspace:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_DRIVE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_ID=optional
```

The refresh token must include the `https://www.googleapis.com/auth/drive.file` scope. The signed-in Workspace user must be able to write to **911 Approved Payroll**.

## 4. What Finalized writes

- Filename: `911-approved-payroll-YYYY-MM-DD-to-YYYY-MM-DD.pdf`
- Same Hours PDF layout as **Download PDF**, plus the watermark
- A second **Finalized** click replaces that period’s file

The regular Hours **Download PDF** button is unchanged (no watermark, no Drive upload).
