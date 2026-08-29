# Cmd+K

[Expense](https://expense.labnotes.org/?ref=labnotes.org) now has a command palette. Press Cmd+K anywhere (Ctrl+K on Windows and Linux) and type what you want to do. Go somewhere, add something, search, export. The mouse is optional.

Some of the keys I actually use:

- `g e` expenses, `g r` reports, `g m` emails, `g f` reconcile, `g s` settings
- `a` new receipt, `m` new mileage, `f` upload a file
- `?` jumps to the search box
- `e` exports a report, then asks which one

Typing in the palette searches your expenses too, so "blue bottle" finds that receipt without opening the list first. Nothing needs memorizing either: every command matches on its own words, so type "mileage" and there it is.

Under the hood it's [kbar](https://kbar.vercel.app), the same small library behind command palettes in a bunch of apps you've used. Most of the work was not adding commands, it was deciding what belongs. If it's something you do every day it gets a key. If it's something you do twice a year, the menus are fine for that.
