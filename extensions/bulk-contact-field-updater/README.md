# Bulk Contact Field Updater

A Chrome Manifest V3 template for replacing contact fields or filling the first empty contact slot across a list of records.

## Configure before use

1. Replace `https://app.example.com/*` in `manifest.json` with the site you are authorized to automate.
2. Review the `CONFIG` object in `content.js` and replace the placeholder names, email tokens, field IDs, routes, and button IDs.
3. Test against a non-production environment and a small record set first.

## Install

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.

Provided as a reusable template. Confirm you have permission to automate the target site and handle its data.
