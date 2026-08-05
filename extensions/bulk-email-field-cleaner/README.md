# Bulk Email Field Cleaner

A Chrome Manifest V3 template for visiting a set of records, clearing a configured email value, and recording the outcome.

## Configure before use

Replace the example host in `manifest.json`. In `background.js`, replace `TARGET_EMAIL` and review all selectors, record-link patterns, pagination behavior, edit/save actions, and verification rules. Test on a non-production site first.

## Install

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.

Provided as a reusable template. Use only on sites and data you are authorized to automate.
