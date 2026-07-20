# asktobooked — Setup Guide

## Files

- `index.html` — Landing page
- `styles.css` — Styles
- `script.js` — Mobile nav + smooth scroll

## Preview locally

Open `index.html` in a browser, or run a local server:

```powershell
cd C:\Users\colto\Projects\asktobooked
python -m http.server 8080
```

Then visit http://localhost:8080

---

## ConvertKit (product purchase)

### Option A — ConvertKit Commerce (recommended)

1. In ConvertKit → **Earn** → **Products**, create a product: **Who Shows Up First?**
2. Set price ($47 or your chosen price)
3. Upload the PDF as the digital download
4. Copy the product checkout URL
5. In `index.html`, replace:
   ```
   https://YOUR_ACCOUNT.kit.com/products/who-shows-up-first
   ```
   with your real checkout link on the **Purchase** button (`#purchase-btn`)

### Option B — Inline form embed

1. In ConvertKit → **Grow** → **Landing Pages & Forms**, create a form tied to your product
2. Copy the embed script
3. Paste it inside `<div id="convertkit-form">` and remove the placeholder text

### Post-purchase funnel

In ConvertKit, set up an automation:

1. **Trigger:** Purchase of "Who Shows Up First?"
2. **Email 1 (immediate):** Deliver PDF + thank you
3. **Email 2 (day 2):** "How's your audit going?" + link to `#consulting`
4. **Email 3 (day 5):** "Only 3 spots this month" + Calendly link

---

## Calendly (consulting calls)

1. Create an event type, e.g. **AI Visibility Strategy Call — 15 min**
2. Copy your Calendly URL (e.g. `https://calendly.com/asktobooked/ai-visibility-audit`)
3. In `index.html`, replace both instances of:
   ```
   https://calendly.com/YOUR_CALENDLY_LINK/ai-visibility-audit
   ```
4. Uncomment the Calendly script at the bottom of `index.html`:
   ```html
   <script type="text/javascript" src="https://assets.calendly.com/assets/external/widget.js" async></script>
   ```

### Limit to 3 spots

In Calendly event settings:

- Set **Maximum bookings per day/week** or use Calendly's availability limits
- Or manually close the event type when 3 clients are booked and reopen next month

---

## Placeholders to replace

| Placeholder | Location |
|---|---|
| `YOUR_ACCOUNT.kit.com/products/...` | Purchase button href |
| ConvertKit embed script | `#convertkit-form` div |
| `YOUR_CALENDLY_LINK` | Consulting section (2 places) |
| `hello@asktobooked.com` | Footer email |
| `$47` | Price (if different) |

---

## Deploy

Upload all files to any static host:

- **Netlify** — drag & drop the folder
- **Cloudflare Pages** — connect repo or upload
- **GitHub Pages** — push to `gh-pages` branch

No build step required.
