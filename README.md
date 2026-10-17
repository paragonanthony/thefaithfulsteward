<p align="center">
  <img src="client/public/logo.png" alt="The Faithful Steward" width="320">
</p>

# The Faithful Steward

A simple, multi-tenant fund accounting system for small non-profit organizations and personal finance tracking.

- **Stack:** Node.js 20+ / Express 5, PostgreSQL, React 19 (Vite). One service: the Express server serves the API and the built front end.
- **Tenancy:** one shared database. Every tenant table has `organization_id`. Each request is checked against the user's organization assignments, and every referenced account, fund or name is verified to belong to the current organization.

## Features

| Area | What's included |
| --- | --- |
| Sign in / organizations | Login, organization picker (auto-selects when a user has only one), system admins create organizations, org admins manage users and roles. **Require a password change at the next sign-in** when adding a user, resetting a password or editing a user: until the user picks a new password (different from the current one) the app shows only the change-password screen, and the server refuses every other request, even for sessions already signed in. Changing a password signs out the user's other sessions |
| Customers, Donors & Vendors | Search list, edit screen with default income and expense accounts, transaction history |
| API and MCP server | REST API and a hosted MCP server for AI assistants, signed in with the user's own account (OAuth) and limited to exactly what that user can do in the web app (see below) |
| Guide Me | Step-by-step wizards for recording income, expenses, bills and deposits in plain language, one question at a time (see below) |
| Lists | Income, Expenses, Bills, Deposits, Journal Entries, Customers / Donors / Vendors, Tuition, Bank Feed and Bank Registers show 500 rows at a time with First / Previous / Next / Last paging; click a column heading to sort by it (again to reverse), across every page, remembered for the session; counts and totals cover every matching row, not just the page |
| Income | Record Income with all the spec's defaulting rules (name → default account, amount → first line, account → default fund on the line, new line = remaining amount and the previous line's fund); the detail lines list Income and Other Income accounts (Expense and Other Expense on expenses and bills) unless **Show all** is ticked; funds are chosen on the detail lines only, and the bank side of the GL is split by the lines' funds so every fund stays in balance, must balance before saving, printable receipt using a customizable template, downloadable as PDF; payments can be applied to tuition records when Tuition Tracking is enabled |
| Expenses | Record Expense with the same rules; checks print using a customizable check format (see below) |
| Bills & Pay Bills | Enter bills owed to vendors (posted to an **Accounts Payable** account), then pay one or several bills from a vendor, in full or in part, with a single check or electronic payment (see below) |
| Deposits | Undeposited-funds popup, add/remove (not edit) deposit items, printable deposit summary |
| Bank registers | Running balance per bank/credit card account from the general ledger, with cleared flags; **+ Bank Transfer** moves money between bank / credit card accounts (see below) |
| Reconciliation | Beginning balance from the prior statement, service charge and interest with account and fund, clear/unclear, *Save & Complete Later*, can't complete until Difference = $0.00, undo latest. Once completed, cleared transactions' totals are **locked** (enforced in the database) while other details stay editable (see below). **Upload the statement** (PDF or image) to fill everything in and clear what's on it, and create any transactions that are missing (see below). Attach files to a reconciliation (an uploaded statement is attached automatically), and print a **Reconciliation Report** |
| Bank feeds | **Live bank connections through SimpleFIN** (see below) or statement import: CSV / OFX / QFX (column mapping, duplicate detection), or a **PDF or photo of a statement read by Claude**; suggested matches (including journal entries), Match / Ignore / Clear, a **Customer / Vendor and Account on each line** (chosen by hand or set by **bank feed rules**, see below) that become the defaults when you create Income / Expense / Journal Entry / Transfer from the line (auto-matched on save). If a matched transaction is later edited so its amount on that bank account changes, the line returns to Not Matched. Income, expense, deposit, journal entry and transfer screens show a caption with the bank feed line they're matched to (account, date, description, amount, source, who matched it) and a link to it |
| Account & fund setup | Chart of accounts (13 account types), funds, account groups, default fund per account, Undeposited Funds flag (bank accounts only), optional standard non-profit chart of accounts for new organizations |
| Advanced: QuickBooks Export Import | Bring in a QuickBooks Online company from its report exports (Journal, Balance Sheet, Profit and Loss, Trial Balance, contact lists), checked against the General Ledger, with undo |
| Advanced: Import Chart of Accounts / Customers & Vendors | Add or update accounts and names from CSV or Excel with column mapping and a full check before saving |
| Advanced: Import Transactions | Import income and expenses from CSV or Excel with column mapping, a full check before saving, automatic creation of missing customers/vendors, duplicate detection, and undo |
| Advanced: Period Closing | Lock the books through a date: transactions on or before it can't be added, changed or deleted (enforced in the database), with a change log |
| Advanced: Journal Entries | General journal entries (date, description, fund; lines with account, fund, description, debit, credit) that post directly to the general ledger, with a searchable list |
| Attachments & document extraction | Attach pictures, PDFs and documents to income, expenses, bank transfers, journal entries and tuition records; **Fill from document** has Claude read a receipt or invoice and fill in the form, following a saved prompt per transaction type (see below) |
| Budgets | Multiple budgets, each with a start and end date, either overall (all funds) or for one fund; monthly amounts per account with spread, copy and fill-from-actuals tools (see below) |
| **Reports** | Profit and Loss, Balance Sheet, **Profit and Loss by Fund**, **Balance Sheet by Fund**, Fund Balances, **Budget to Actual Profit and Loss**, **Budget to Actual Balance Sheet**, **Unpaid Bills Aging**, Trial Balance, plus a **Report Designer** for customizing these and creating new reports |

### General ledger

Saving an income, expense, deposit or reconciliation writes `gl_headers` and `gl_details` rows exactly as described in the
spec (transactions and GL are separate tables). Every GL entry is checked to make sure debits equal credits before it is saved.
Each transaction screen has a collapsible **General ledger entries** panel that shows the lines it generated.

## Deleting an organization

System administrators can delete an organization from **Manage organizations** (user menu): open it, then
**Delete organization…**. The confirmation lists what will go (transactions, accounts, names, attachments, bank feed
lines and the users who lose access) and the organization's name must be typed to confirm.

- **Everything** that belongs to the organization is deleted in one transaction:
  - transactions with their lines and general ledger entries, reconciliations, deposits and bills
  - accounts, funds, names, budgets, tuition, reports, templates and settings
  - attachments, bank feed lines and rules, and bank connections with their stored access
  - its Claude key and prompts, imports and the period-closing history
  Closed periods and completed reconciliations don't block it: those database checks stand aside only for the
  organization being deleted.
- **User accounts** that belonged only to this organization are deleted too (untick the option to keep them). A user
  still named on records elsewhere is deactivated instead. Users who also belong to other organizations keep their
  accounts and simply lose access to this one.
- Other organizations are untouched. It can't be undone, so download any reports you want to keep first.

## Guide Me

**Guide Me** (first in the side menu, and on the Main Menu) walks people who aren't bookkeepers through the everyday
entries one question at a time. It starts with "What happened?":

- **I received money** (income): who it came from → how much and when → how it arrived (check, cash, electronic) and
  where it is now → what it was for (income account, optional fund and note) → review.
  Checks and cash default to Undeposited Funds, with a reminder to use "I took money to the bank" later; electronic
  payments default to the bank account.
- **I paid for something** (expense): who was paid → how much and when → how it was paid (check with its number,
  credit card, debit / transfer / online, cash) and from which account → what it was for → review.
- **I got a bill to pay later** (bill): the vendor → amount, bill date, due date (on receipt, 15 or 30 days, or another
  date) and bill number → what it was for → review. If there's more than one Accounts Payable account, it asks which.
- **I took money to the bank** (deposit): tick the checks and cash waiting in Undeposited Funds (with a running total to
  compare with the deposit slip) → which bank account and the date → review. If nothing is waiting, it explains why.

Names can be added on the spot. A name's default account and the account's default fund are filled in for you. Each step
checks its answers before moving on, the progress pills let you jump back, and the review shows a plain-English summary
("You received $125.00 from Jane Smith on 10/16/2026 by check …"). Saving uses the same rules as the full screens.
Afterwards: **Record another**, **Deposit it now** (for income in Undeposited Funds), **Pay this bill now**, **Open it**
or **Done**.

## Bank Transfers

**Bank Registers → + Bank Transfer** moves money between two of your bank or credit card accounts, for example from
checking to savings or a credit card payment.

- **Fields:** **Date**, **Amount**, **From** and **To** account (bank and credit card accounts, not Undeposited Funds; ⇄ swaps
  them), plus an optional **Fund**, **Reference #** and **Memo**. From and To must be different.
- **General ledger:** saving posts one entry that debits the To account and credits the From account for the amount.
  The transfer appears in both registers, and its GL lines show under *General ledger entries*.
- **Reconciliation and bank feeds:** each side is cleared in its own account's reconciliation and can be matched to each
  account's bank feed line. **Create Transfer** on a feed line pre-fills the transfer and matches it when saved.
  Once a side is in a completed reconciliation, the accounts and amount are locked, and the transfer can't be deleted.
- Transfers respect the Period Closing date.

## Advanced: Journal Entries

**Advanced → Journal Entries** (also on the Main Menu and side navigation) is for accountants and bookkeepers: accruals,
corrections, reclassifications between accounts or funds, opening balances and transfers.

- **List:** filter by date range and search by description, entry number, amount, or any line's description or account. **Add Journal Entry** starts a new one.
- **Entry:** a header with **Date** and **Description**, and two or more lines with **Account**, **Fund**,
  **Description**, **Debit** and **Credit**.
  - Funds are set on the lines. Choosing an account fills in its default fund; **+ Add line** uses the previous line's fund.
  - A line is either a debit or a credit: typing one clears the other. **+ Add line** pre-fills the amount needed to balance.
  - The entry can only be saved when total debits equal total credits.
- **Saving** posts one general-ledger entry with a GL line per journal line. The entry shows up in every report,
  drill-down and bank register. Editing replaces the GL lines; deleting removes them. Each entry shows its GL lines under
  *General ledger entries*.
- **Bank and credit card lines are reconciled.** When you reconcile an account, each journal entry that touches it
  appears once, for its net effect on that account: debits as deposits, credits as payments (or credits and charges on a card).
  - Clearing marks only that account's lines, so both sides of a transfer between two bank accounts are reconciled
    separately, each in its own account's reconciliation. The register shows the cleared mark per account.
  - Once cleared in a **completed** reconciliation, the entry can't be deleted and its total to that account can't change.
    Descriptions, funds and its other lines can still be edited.
  - In a reconciliation still in progress, changing the amount just makes the item uncleared again.
- **Bank feeds:** journal entries are suggested and matched on their net effect on the feed line's bank account, once
  per account. A transfer can be matched to both the checking and the savings feed lines. **Create Journal Entry** on a
  feed line opens a new entry with the bank side filled in, and it's matched when saved.

## Advanced: Period Closing

**Advanced → Period Closing** locks the books through a date. Once a closing date is set, no transaction dated on or before it
can be **added, changed or deleted**. A transaction also can't be moved into or out of the closed period by changing its date.

- **Covers everything that posts to the books:** income, expenses, deposits, journal entries, reconciliations (including service
  charges and interest), bank-feed-created transactions, tuition payments and imports. Import checks flag closed-period rows as errors.
- **Enforced in the database** (triggers on transactions and general-ledger postings), so no screen, import or future
  feature can bypass it. The server returns a clear message instead of a generic error.
- **Still allowed:**
  - clearing closed-period transactions in a later bank reconciliation;
  - matching bank feed lines;
  - including closed-period undeposited income in a deposit dated after the closing date;
  - printing receipts and checks;
  - running reports.
- **Screens:** transaction screens show a banner and disable Save and Delete for closed-period items. They also warn when
  the date entered is in the closed period.
- **Admins only:** only organization administrators can set, change or remove the closing date. It can't be in the future. Every change
  is logged with the previous and new dates, who made it, when, and an optional note. **Reopen all periods** removes the closing date.

## Advanced: QuickBooks Export Import

**Advanced → QuickBooks Export Import** brings in a QuickBooks Online company from its **report exports** (Excel or
CSV), with no connection to QuickBooks needed. Choose all the files at once; each is recognised by its report title:

| Export from QuickBooks (dates: All Dates) | Used for |
| --- | --- |
| **Journal** (Reports → Journal) | Every transaction with all its lines. Required for transactions |
| **Balance Sheet** and **Profit and Loss**, or the **Account List** | Each account's type, from the report sections (Bank Accounts, Credit Cards, Other Current Liabilities, Expenses, …) |
| **Trial Balance** | Accounts without activity |
| **Customer / Vendor / Employee contact lists** | Names, with phone, email and address when included. Names used on transactions are added too |
| **General Ledger** (optional) | Checking that the Journal has every transaction: the net debits per account must match |

**Read files** shows what will happen before anything is saved:
- **Transactions** by type, the date range, and any skipped: already imported, in a closed period, outside the optional
  date range, or with problems (lines that don't balance). They're saved as:
  - **Income** / **Expense**: one bank or credit card account and every other line on the other side (deposits,
    expenses, checks with their check number, card charges and refunds). The QuickBooks name becomes the customer / vendor.
  - **Transfer**: two bank / card accounts (transfers, credit card payments).
  - **Journal Entry**: QuickBooks journal entries and anything else.
- **Accounts**: each QuickBooks account is matched to an account with the same name or created with the type from the
  reports. Map any of them to a different existing account or change the type; accounts the reports don't type (only in
  the Journal) need a type chosen. Sub-accounts keep QuickBooks' full name, e.g. "Auto Expenses:Gas".
- **Names**: how many are new.

**Import** saves it all as one batch (listed under Recent imports with **Undo**, which deletes the transactions and the
accounts and names it created that aren't used elsewhere). Each transaction is remembered, so importing the same export
again — or a later export covering the same dates — skips what's already been imported.

## Advanced: Import Chart of Accounts and Customers & Vendors

**Advanced → Import Chart of Accounts** and **Advanced → Import Customers & Vendors** (also the **Import** buttons on
Accounts & Funds and on Customers, Donors & Vendors) add or update records from a **CSV** or **Excel (.xlsx)** file, one
per row. Choose the file, match its columns (headings like "Account #", "Zip" or "E-mail" are recognised), click
**Check file**, review, then **Import**. **Download template** gives a ready-made file.

- **Chart of accounts columns:** Account Number, **Account Name**, **Account Type**, Description, Account Group,
  Default Fund, Active, Undeposited Funds.
  - Account Type accepts the app's types and common names from other systems (Other Current Asset, Accounts Receivable,
    Other Current Liability, Revenue, Cost of Goods Sold, …).
  - An existing account is matched by number, or by name when there's no number. Its type can't be changed (except
    between Current Liability and Accounts Payable, as on the account screen).
  - Account groups that don't exist yet are created; the default fund must already exist.
- **Customer / vendor columns:** **Name**, Address 1, Address 2, City, State, Postal, Phone, Phone 2, Email, Notes,
  Default Income Account, Default Expense Account, Active. Default accounts are matched by name or number and must be
  income / expense accounts.
- Matching ignores capitals and extra spaces. A name or account that appears twice in the file is an error.
- Records that already exist are left alone unless **Update existing records** is ticked; then the cells that have a
  value replace what's there and blank cells keep the current value.
- Rows with errors are skipped; nothing is saved until you click Import. Import the chart of accounts before names
  whose default accounts refer to new accounts.

## Advanced: Import Transactions

**Advanced → Import Transactions** brings in income and expenses from a **CSV** or **Excel (.xlsx)** file, one transaction
per row. **Download template** gives a ready-made file.

| Column | Notes |
| --- | --- |
| Date | Excel dates, `YYYY-MM-DD`, `M/D/YYYY` or `M/D/YY` |
| Header Account | The bank or credit card account (Deposit To / Bank Account) |
| Detail Account | The income or expense account |
| Amount | Positive number; `$` and `,` are fine |
| Fund | Optional; the detail line's fund (the bank side follows it) |
| Description | Optional; becomes the memo |
| Transaction Type | `Income` or `Expense` |
| Customer/Vendor | Optional; created automatically if it doesn't exist |

- **Matching:** accounts are matched by **Account Name** (an account number also works) and funds by **Fund Name**,
  ignoring capitals and extra spaces. Customers/vendors are matched by name; missing ones are created, once per name.
- **Columns** are matched automatically by heading (Bank Account, Category, Memo, Payee and similar also work). Any can be
  re-mapped by hand.
- **Check first:** **Check file** validates every row without saving anything. It shows errors per row (unknown account or
  fund, bad date, wrong type, non-bank header account, …), lists the names that will be created, and flags *possible
  duplicates* of existing transactions (same date, type, amount, account and name). Duplicates are skipped by default.
- **Import:** valid rows become normal Income and Expense transactions, posted to the general ledger. The import
  runs in one database transaction: it either completes fully or nothing is saved. Rows with errors are skipped. Up to 2,000 rows per file.
- **Undo:** **Recent imports** lists each import. **Undo** deletes its transactions and any customers/vendors it created
  that aren't used elsewhere. Undo is refused, and nothing is deleted, if any of its income has been deposited or any
  transaction reconciled.
- Older `.xls` files aren't supported; save them as `.xlsx` or CSV first.

## Tuition tracking (optional)

Turn this on in **Organization settings → Features → Enable Tuition Tracking**. A **Tuition** entry then appears in the Main
Menu and the side navigation. When it's off, the tuition screens and API are unavailable.

- **Tuition records** have a date, customer and total tuition amount. Each can also carry a description (e.g.
  "2026–27 Tuition"), plus the income account and fund to use when payment is received.
- **Paid and balance** are calculated from income: on Record Income, each detail line has a **Tuition** column. It lists the
  selected customer's tuition records that still have a balance due. One payment can cover several records (for example
  two children), or part of one.
  - Editing or deleting the income updates the tuition balance automatically.
  - Overpayments show as a credit.
  - Tuition can only be linked to income received from the same customer.
- **Tuition page:** filter by balance due / paid in full / all, search, and see totals.
  - **Receive** on a row opens Record Income already filled in: customer, remaining balance, account, fund, and the line
    linked to that record. After saving you return to Tuition.
  - **Receive Tuition** opens Record Income with the Tuition column for any customer.
- **Create Multiple:** enter a date, amount, description and optional account and fund, then tick customers (with filter and
  select-all). One tuition record is created for each. Customers who already have tuition with the same date and
  description are skipped unless you untick that option.
- Records with payments can't be deleted or moved to another customer.

**Tuition reports.** With tuition tracking on, Reports gets a **Tuition Reports** section:

- **Tuition Balances (standard):** every tuition record with a balance due as of a date, grouped by customer with subtotals.
  Shows tuition, paid, balance and days outstanding. It can be customized and reset like the other standard reports.
- **Custom tuition reports:** choose **New Report → Tuition report**, or customize / Save As an existing one.
  - **Dates:** balances *as of a date* (only payments dated on or before it count), or *tuition dated within a period*.
  - **Filters:** unpaid / paid in full / all, specific customers, funds (including "No Fund"), description text, minimum balance.
  - **Columns** (choose and order): date, customer, description, tuition, paid, balance, % paid, last payment, number of
    payments, days outstanding, 0–30 / 31–60 / 61–90 / over-90 day aging, fund, income account, memo, email, phone.
  - **Layout:** group by customer, fund, description or month, with subtotals or one summary line per group. Sort by any column; grand total.
- Click a row to open the tuition record. Export CSV and Print work as for other reports. Tuition reports are hidden (and
  can't be run) while tuition tracking is turned off.

## Check formats

**Accounts & Funds → Check Formats** holds the layouts used by **Print Check** on the Expense screen. Each organization
starts with a *Standard voucher check* (check on top, two stubs), which matches common pre-printed voucher check stock.

- **Visual editor:** drag fields on a to-scale preview, or type positions in inches. Fields: date, payee, amount, amount in
  words, payee address, memo, organization name and address, bank account name, check number and signature line. Each can be
  shown or hidden and resized.
- **Check stock:** *Pre-printed checks* prints only the variable data. *Blank check paper* also prints labels, a border, your
  organization details, the check number and a signature line. Note that no MICR line is printed, so blank paper still needs
  bank-encoded stock.
- **Sheet layout:** check on top, in the middle or at the bottom; check height; 0–2 voucher stubs, with or without expense lines.
- **Text:** font, size, date format, and `**` amount protection.
- **Printer alignment:** *Print alignment test* prints sample data on plain paper to hold against a blank check. Then nudge the
  whole layout right or down until it lines up.
- **Multiple formats:** one is the default. A bank account can use a different one (set it on the account), and the print page
  can switch formats.

When printing, set the browser's print **Scale** to 100% and **Margins** to None so positions match your check stock.
Only organization administrators can change formats.

## Receipt templates

**Accounts & Funds → Receipts** holds the templates used by **Print Receipt** on the Record Income screen. Each organization
starts with a *Standard receipt*. Templates can be added and one set as the default, and a different template can be chosen when printing.

- **Branding:** logo (resized in the browser and stored with the template), title, accent color, font and size, date format.
- **Header:** organization address, phone and email, EIN and receipt number, each shown or hidden. These details come from Organization settings.
- **Donor and gift:** donor address, positioned for a #10 window envelope if wanted; itemized lines with optional fund and
  account columns, or the total only; payment method.
- **Wording:** opening and closing messages, tax acknowledgment and footer. Merge fields such as `{{donor_name}}`, `{{amount}}`,
  `{{date}}`, `{{receipt_number}}`, `{{payment_method}}`, `{{fund}}`, `{{org_name}}` and `{{ein}}` can be inserted with one click.
- **Signature block:** name, title and an optional signature image.

Only organization administrators can change templates. Review the tax acknowledgment wording with your accountant.

## Reporting module

Every organization gets editable copies of the standard reports. From **Reports** you can:

- **Trial Balance (standard):** every account's balance as of a date in a **Debit** or **Credit** column, with matching
  totals. Balance sheet accounts show their cumulative balance. Income and expense accounts show the current fiscal year,
  and earlier years' net activity appears on one *Net Assets – Prior Years' Activity* line (there are no closing entries).
  Options: which funds to include, group by account type with subtotals, zero-balance accounts, account numbers. Click an
  amount to see its transactions (income and expense drill-downs start at the fiscal year).
- **Unpaid Bills Aging (standard):** accounts payable aging as of a date. It lists each vendor's unpaid bills, with vendor subtotals,
  in **Current**, **1–30**, **31–60**, **61–90** and **Over 90** days past due, plus a Total.
  - A bill's balance is its amount less payments dated on or before the report date, so the report can be run for any past date.
  - Bills without a due date are due on their bill date. Click a bill to open it.
  - Options (on the report or under **Settings**): age by days past due or by days since the bill date, days per column and
    number of columns, each bill or one line per vendor, and which funds (by each bill's fund).
- **Run** a report and change it on the fly: date range or as-of date, columns (total, by fund, by month, by quarter, by fiscal year,
  compare to prior year, compare to budget), which funds to include, % of a row, zero-balance accounts, account numbers. Then **Save changes** or **Save As** a new report.
- **Drill down:** click any amount to see the GL lines behind it, and open the original transaction.
- **Export CSV** or **Print**.
- **Customize** in the Report Designer, with a live preview. A report is a list of rows:
  - **Accounts:** accounts matching filters on category, account type, account group and/or specific accounts. You can show each account, group them by type or account group with subtotals, show one line per group, or show a single total line.
  - **Formula:** for example `income - expense` or `(net_operating + net_other) * 1`, using row IDs. Renaming a row ID updates the formulas that refer to it.
  - **Change in net assets:** for the period, the current fiscal year, or prior fiscal years. Balance sheets use this because there are no year-end closing entries.
  - **Heading** and **Blank line**.
- **New Report:** choose *activity for a period* (P&L style) or *balances as of a date* (balance sheet style), then design it.
- **Reset to standard layout** restores a built-in report. Built-in reports can't be deleted.

The *by fund* reports include a **No Fund** column when entries have no fund. *Balance Sheet by Fund* adds an
**Interfund Balances** line only when a fund's assets don't equal its liabilities plus net assets. That happens when one
transaction moves value between funds, for example income deposited under the General Fund with a line coded to a restricted fund.

## Bills and Pay Bills

**Bills** (side navigation and Main Menu) records what you owe vendors before you pay them.

- **Enter Bill** works like Record Expense: vendor (required), bill date, **due date**, bill number, fund, memo, and expense lines with
  account, amount, memo and fund. The header account is an **Accounts Payable** account instead of a bank or credit card account.
  Saving posts Dr each expense line / Cr Accounts Payable, so the expense counts in the P&L on the bill date.
- **Accounts Payable** is its own account type, a liability. New organizations' *2100 Accounts Payable* has it. For existing
  organizations, Current Liability accounts named "Accounts Payable…" were converted. Any Current Liability account can be
  switched to Accounts Payable, and back if it has no bills, on its Edit Account screen.
- **The Bills list** shows unpaid, paid or all bills with amount, paid and balance, flags overdue bills, and totals what's unpaid.
- **Pay Bills** (from Bills, Expenses, or a bill's **Pay** button):
  1. Choose a vendor. Only vendors with unpaid bills are listed.
  2. Tick the bills to pay. Each starts at its full balance; type a smaller amount to **pay part of a bill**.
  3. Choose the payment date, the bank or credit card account, check or electronic, and the check number.
  - One **expense** is recorded for the total, with a line per bill to its Accounts Payable account and fund: Dr A/P / Cr bank.
    It prints as a check, shows in the bank register, and reconciles and matches bank feed lines like any expense.
- **Partial payments** add up across as many payments as needed. A bill shows each payment and its remaining balance.
- **Rules:**
  - A payment can't be more than the bill's open balance, and must be for a bill from the expense's vendor.
  - Editing a payment's bill line changes how much of the bill is paid; deleting the payment reopens the bill.
  - A bill with payments can't be deleted, and can't change vendor or Accounts Payable account. Its amount can't go below what's
    been paid.
  - The **Unpaid Bills Aging** standard report (Reports) shows what's owed by vendor and days past due.
  - Bills follow the Period Closing date. They accept attachments, and **Fill from document** reads vendor invoices into a bill
    using its own saved prompt.

## Attachments and Fill from document

Income, expense, bill, bank transfer, journal entry and tuition screens have an **Attachments** panel.

- **Attach files:** click **+ Attach file** or drag files onto the panel. Accepted files are PDF, JPEG, PNG, GIF, WebP, HEIC,
  TXT, CSV, Word and Excel, up to 10 MB each and 25 per record.
  - On a new record, files are kept with the form and attached when you save it.
  - Files are stored in the database, so nothing extra is needed on Railway.
  - PDFs and images open in the browser; other files download. Uploads are checked to be the type their extension says.
  - Deleting a transaction or tuition record deletes its files.
  - Files can be added to transactions in a closed period, since they don't change the books.
- **Fill from document:** on a PDF, image, TXT or CSV attachment, this sends the file to the Claude API (`claude-opus-5-5`).
  It also sends your saved prompt for that transaction type and your active accounts, funds and customer / vendor names.
  Claude's answer fills in the form; **nothing is saved until you click Save**. Only the fields Claude found are changed.
  - Every account, fund and name Claude suggests is checked against your own lists. Anything that doesn't fit, such as
    a bank account used as an expense line, is left blank and noted.
  - A vendor or customer that isn't in your list yet can be added in one click.
  - Amounts locked by a reconciliation or deposit aren't changed.
  - Word, Excel and HEIC files can be attached but not read. Save them as PDF to use Fill from document.
- **Saved prompts:** under **Organization settings → Document extraction prompts**, org admins edit the instructions Claude
  follows for each type (Income, Expense, Bill, Bank Transfer, Journal Entry, Tuition), and for reading bank statements into the bank feed. For example: "Code all Amazon purchases to
  Program Supplies." **Reset to standard prompt** restores the built-in one.

**Setup:** each organization uses its **own** Claude API key; there is no server-wide key.
- An organization administrator creates a key in the Anthropic Console (console.anthropic.com → API keys) and saves it
  under **Organization Settings → Claude API key**. The key is checked with Anthropic, stored **encrypted** with
  `ENCRYPTION_KEY` in its own table (`organization_claude_keys`), and never shown or sent to the browser again (only
  its last 4 characters). **Remove key** turns Claude off for that organization.
- Usage is billed to that organization's Anthropic account, and documents are processed under its API terms.
- Without a key, attachments still work, and Fill from document, reading PDF / photo statements and Auto Classify are hidden.
- Optionally set `ANTHROPIC_MODEL` on the server to use a different Claude model for every organization.
- **Moving from a server key:** `ANTHROPIC_API_KEY` is no longer used. Add each organization's key in its settings, then
  remove the variable from the server.

## Budgets

**Budgets** (side navigation and Main Menu) holds any number of budgets. Each has a **name**, **start date** and **end date**
(up to 60 months), and is either:

- **Overall:** covers all funds and is compared to the organization's total actuals; or
- **Fund:** covers one fund and is compared to that fund's actuals only. A fund with a fund budget can't be deleted.

**Entering amounts:** the budget screen is a grid of accounts by month.
- Income and expense amounts are the activity for each month.
- Type a yearly figure in **Total** to spread it evenly across the months. **⇥** copies the first month to every month, and **✕** clears a row.
- **Include balance sheet accounts** adds asset, liability and net-asset rows, where amounts are the planned **change** in the balance.
- **Fill from last year's actuals** copies each month's actual activity from one to three years earlier (in the budget's
  fund, for a fund budget). It can fill only empty amounts or replace them all, and nothing is saved until you click Save.
- If the start or end date falls mid-month, that month is partial: enter the amount for just the days the budget covers.
- **Copy** (on the Budgets list) duplicates a budget, optionally moved to a new start date, for example next year's budget.

**Budget to Actual reports:** *Budget to Actual Profit and Loss* and *Budget to Actual Balance Sheet* are standard reports
with **Actual**, **Budget**, **$ Over / (Under) Budget** and **% of Budget** columns. Choose the budget on the report, or open it
from a budget, which also sets the report dates to the budget's dates. Left on *Automatic*, the report uses a budget covering
the report date. Any custom report can use **Compare to budget** columns too.
- **P&L:** the budget column is the budgeted amount for the report period. A month only partly in the period is prorated by day,
  and the budget is zero outside its dates.
- **Balance Sheet:** the budget column starts from the actual balances the day before the budget starts, then adds the
  budgeted changes through the report date. Change in Net Assets uses the budgeted income and expenses. A budget with
  only income and expenses therefore shows budgeted net assets, but unchanged asset and liability balances.
- Budget amounts aren't drillable; actual amounts are.

## Audit fields

Every table has **Created By**, **Created Date**, **Last Updated By** and **Last Updated Date** columns
(`created_by_user_id`, `created_at`, `updated_by_user_id`, `updated_at`).

- A database trigger on every table fills them in, so no screen or import can skip them.
  - **Adding** a record sets all four to the signed-in user and the current date and time.
  - **Changing** it updates only the *Last Updated* pair. The *Created* pair can't be overwritten, even by a direct database update.
- The server tells the database who the signed-in user is for every write in a request (setting `app.user_id`
  for that transaction). Writes outside a request, such as scheduled bank syncs or webhooks, record no user.
- Edit screens show "Created … by … · Last updated … by …" for transactions, deposits, reconciliations, journal entries,
  customers/vendors, accounts, funds, account groups, tuition records, reports, check formats, receipt templates,
  organization settings and users.
- Lines and general-ledger rows are rebuilt each time a transaction is saved, so their *Created* values show who last
  saved the transaction. The transaction itself keeps its original *Created* values.
- Existing records were stamped when this was added: their creator was kept where one had been recorded.

## Decisions where the spec was open or ambiguous

1. **Deposit GL by fund.** The spec describes one debit for the deposit total. The debit is split into one line per fund of
   the deposited income items. The total is the same, and each fund's cash stays correct on the by-fund balance sheet. When
   all items share a fund, it is a single line, as the spec describes.
2. **Interest earned account.** The spec says to credit the account "from the Service Charge Line". I treated that as a
   typo and credit the **Interest Earned** line's account.
3. **Cleared balance includes service charges and interest.** Cleared = Beginning + Deposits − Payments − Service Charge +
   Interest. Without this, a statement that includes those items can never reach a $0.00 difference.
4. **Credit card reconciliation** shows balances as the amount owed, so charges increase the balance. As the spec says, the
   reconciliation grid lists transactions whose *header* account is the card. A card payment entered as an expense from checking
   therefore reconciles on the checking account.
5. **Locking:** transactions in a completed reconciliation can't be deleted, and their amount and bank account can't change.
   Deposited income can't be deleted, and its amount and Deposit To can't change.
6. **Deposit To** on the deposit screen excludes Undeposited Funds accounts.
7. **Live bank feeds** import only *posted* transactions. Pending ones show up once they clear, which avoids duplicates when a pending charge posts with a new ID.

## Reconciliation report and attachments

**Reconciliation Report** (a button on the reconciliation screen, and **Report** on the Reconciliations list) is a printable
report of the reconciliation **as of its statement date**.

- **Statement:** beginning balance; deposits / credits and checks / payments cleared, with counts; service charge and
  interest; the cleared balance; the statement ending balance; and the difference.
- **Register as of the statement date:** the cleared balance plus uncleared deposits, less uncleared payments, gives the
  register balance.
  - If that doesn't equal the account's balance in the books on that date, the gap is shown. This happens, for example,
    when a cleared transaction is dated after the statement date.
- **Cleared transactions** and **uncleared transactions as of the statement date** are listed, each split into money in
  and money out, with totals.
  - "Uncleared as of the date" includes transactions dated on or before it that weren't cleared then, even if a later
    reconciliation has cleared them since. Running an old reconciliation's report shows what was outstanding at the time.
- The memo and the attached files are listed at the end.
- Credit cards use credits / charges, with the amount owed as the balance.
- For a reconciliation still in progress, the button saves it first, then shows the report of the current cleared items.

**Attachments:** reconciliations have the same **Attachments** panel as transactions. When a statement is uploaded to be
read by Claude, the file is attached automatically. On a new reconciliation it's kept with the form and attached at the
first save.

## Reconciled transactions are locked

When a reconciliation is **completed**, every transaction cleared in it keeps the total it posted to the reconciled bank or
card account until the reconciliation is undone. You can still edit everything that doesn't change that total.

| | Can't change | Can still change |
| --- | --- | --- |
| Income, expense, bill payment | Amount, bank account; can't be deleted | Date, payee, memo, check / reference number, method, fund, and how the amount is split across lines and accounts |
| Deposit | Its items and account; can't be deleted. Its incomes' amounts are locked because they're deposited | Date and memo; the incomes' lines, funds and other details |
| Journal entry, bank transfer | The net amount to the reconciled account (a transfer's other side is locked by that account's own reconciliation); can't be deleted | Description, date, funds, other accounts' lines, and how the reconciled account's amount is split across lines |

- **Enforced twice:** the screens and the API refuse these changes with an explanation. The database also enforces them,
  as with the Period Closing date.
  - Completing a reconciliation records each cleared transaction's total to the account (`reconciled_totals`).
  - A check at commit refuses any change to a transaction's general-ledger postings that would make its total differ, or
    that would delete it, whatever code path makes the change.
  - Rewriting the postings with the same total (as every save does) passes.
- **Undo** the reconciliation (the most recent one for the account) to change a cleared amount; completing it again
  records the new totals.
- In a reconciliation that's still in progress, changing a cleared transaction's amount just makes it uncleared again.

## Reconciling from an uploaded statement

On **Reconcile Accounts**, after choosing the account, **Upload statement (PDF or image)** has Claude read the statement.
It then sets up the reconciliation:

- **Fills in the header:** the **statement ending date** and **ending balance**.
  - The **service charge** and **interest earned** totals come from the statement's fee and interest lines, dated on the
    statement date.
  - If no account is chosen yet, the account defaults to one named like "Bank Service Charges" or "Interest Income".
- **Clears and unclears transactions:** transactions on the statement are cleared, and everything else is uncleared.
  - A statement line matches an uncleared transaction with the same amount and direction. A matching check number counts
    first, then the closest date: within 10 days, or 90 days for checks, since they can take a while to clear. Each
    transaction matches one line at most.
  - A fee or interest line that matches a transaction you've already recorded clears that transaction instead of being
    added to the service charge or interest.
  - The list marks transactions *On statement* (hover for the statement line) and *Not on statement*: those dated on or
    before the statement date that weren't found.
- **Lists lines missing from your books:** each has the same choices as a bank feed line. These are **Create Income /
  Deposit** (money in) or **Create Expense** (money out), plus **Journal Entry** and **Transfer**.
  - Creating one saves the reconciliation and adds the line to the bank feed.
  - It opens the usual screen, filled in from the line. Saving matches the feed line, comes back to the reconciliation, and
    clears the new transaction automatically.
- The statement's period, balances and the check that its lines add up are shown, along with any warnings. The extract
  is saved with the reconciliation, and the statement file is attached to it. **Remove** or **Upload a different statement** start over.
- Reading statements uses the organization's Claude API key and the saved **Bank Statement** prompt (Organization
  settings). Without the key, the upload button isn't shown.

## Importing statements (CSV, OFX, QFX, PDF or image)

**Bank Feeds → Import Statement** brings a statement's lines into the bank feed for the selected bank or credit card account.
Lines already imported are skipped.

- **CSV:** choose the date, description and amount columns (or separate debit and credit columns), and whether to reverse
  signs. **OFX / QFX** files are read directly.
- **PDF or image (with Claude):** upload the PDF statement your bank provides, or a photo or scan of a paper statement
  (JPEG, PNG, GIF or WebP, up to 10 MB). Claude (`claude-opus-5-5`) lists every transaction with its date, description and
  signed amount.
  - Money in is positive and money out negative. For a credit card, charges are negative and payments positive.
  - You then **review the lines before anything is saved:**
    - Each line has a checkbox, and **Reverse signs** is there if money in and out came out swapped.
    - Lines that look like ones already in the feed (same date and amount) are marked *Possible duplicate* and start unticked.
    - The statement's account, period and opening / closing balances are shown, with a check that the lines add up to the
      change in balance. If they don't, the difference is shown, so you can spot a missed or misread line.
  - Lines whose date or amount couldn't be read are left out (and counted), and lines dated outside the statement
    period are flagged.
  - The instructions Claude follows can be changed under **Organization settings → Document extraction prompts → Bank
    Statement**, for example "our bank prints withdrawals in parentheses".
  - This uses the organization's Claude API key, like Fill from document (see Attachments). Without it, PDFs and images
    aren't offered. The statement file itself isn't stored.

## Bank feed lines: customer / vendor, account and rules

On the Bank Feed's **Not Matched** tab, each line has a **Customer / Vendor** and an **Account**.
- Choosing a customer / vendor that has a default account sets the account too: its default income account for money in,
  or its default expense account for money out. You can still change the account.
- **Create…** on the line opens a new Income or Expense with that customer / vendor, the account on the first detail
  line (and that account's default fund), the bank account, date, amount and memo filled in. A Journal Entry gets the
  account on its second line; a Transfer gets it as the other bank account when it's a bank or card account.
- **Rule…** starts a new rule from the line.
- **Quick Add** (the lightning icon) creates the transaction straight from the line and matches it: **Income** for money
  in, an **Expense** for money out, on the line's bank account, with the line's account (and that account's default
  fund), customer / vendor (optional), date, amount and bank description as the memo. It's only available once the line
  has an account.

**Bank feed rules** (the **Rules** button on the Bank Feed, or Bank Feed Setup → Bank feed rules) fill these in automatically.
- A rule matches lines whose description **contains** some text (ignoring upper / lower case). It can also require
  money in or out, an amount range (**Amount from** = that amount or more, **Amount under** = less than that, ignoring
  the sign), and a particular bank account.
- It sets a customer / vendor, an account, or both. With only a customer / vendor, its default account is used.
- Rules are tried in order (move them with the arrows); the **first** matching active rule wins. For example:
  description contains "Caseys", money out, Amount from $10 → Fuel; and description contains "Caseys", money out,
  Amount under $10 → Food. A line set by a rule shows *Rule: name* under its account.
- Rules apply to new lines from statement imports and bank connections. Adding, changing, reordering or deleting a rule
  applies the rules again to all unmatched lines.
- A line you've set by hand keeps your values; rules don't change it. Clear both fields to let the rules apply again.
  Matched and ignored lines are never changed.

**Auto Classify** (Bank Feed, Not Matched tab; shown when the organization has a Claude API key) asks Claude to fill in
the customer / vendor and account for the selected bank account's unassigned lines.
- Claude picks a customer / vendor only when the description clearly names one of yours, and an Income / Other Income
  account for money in or an Expense / Other Expense account for money out. It leaves a field blank when it isn't sure.
  With a customer / vendor but no account, that name's default account is used.
- It's sent the bank descriptions and amounts, your income and expense accounts, your customer / vendor names (with
  their default accounts), and up to 120 lines you've already matched, as examples of how you code activity. Up to 200
  lines are classified per run, newest first; run it again for more.
- Lines set by hand or by a rule are never sent or changed. Lines Claude sets show its short reason under the account,
  keep their values when rules change, and can be changed like any other line.
- **Your instructions:** the dialog shows the organization's **Bank Feed Auto Classify** prompt, which organization
  administrators can edit there or under **Organization Settings → Document extraction prompts**. Add how you code
  particular vendors or deposits, e.g. "Caseys under $10 is staff snacks; over $10 is Fuel".

## Live bank feeds (SimpleFIN)

Live bank feeds use [SimpleFIN](https://www.simplefin.org/). The banks are connected at a SimpleFIN server (normally the
[SimpleFIN Bridge](https://bridge.simplefin.org/)), and the app reads their transactions from there.

**Connecting (organization administrators)**

1. Sign in at the SimpleFIN Bridge and connect the organization's banks there.
2. In the Bridge, under **Apps**, create a new connection and copy the **setup token**.
3. In the app, go to **Bank Feeds → Bank Feed Setup → Connect bank**, paste the setup token, optionally give it a name, and click **Connect**.

The app exchanges the setup token (it works only once) for an **access URL**, the credentials for reading the accounts.
The access URL is stored **encrypted** in the database for that organization (`simplefin_connections`) and is never sent
to the browser. One connection can cover several banks, and an organization can add more than one connection.
Banks you add at SimpleFIN later appear on the next sync, or right away with **Refresh accounts** on the connection
(Bank Feed Setup); map them like the others.

**Using it** (on **Bank Feed Setup**; the Bank Feed screen itself shows only the bank lines)

- **Mapping:** each account the connection can see is listed. For each one, choose the ledger account it **feeds into**
  and an **Import from** date, then tick **Import** and **Save**. The date defaults to 30 days ago, so activity you've
  already entered isn't brought in. Saving reads that account's history from the Import from date.
- **Imported lines:** new posted transactions appear under **Not Matched** with a *Live* badge. Match them, or turn them into
  transactions, like file imports.
  - Pending transactions are imported once they post.
  - Money in is positive and money out negative, as in the rest of the bank feed.
- **Sync:** one request reads every imported account on a connection. Each sync re-reads the last 10 days, so
  late-posting transactions aren't missed.
  - **Sync Now** on the Bank Feed screen checks every connection of the organization immediately (it appears once an account is imported). SimpleFIN servers update bank data about once a day and limit how many requests
    they answer per day, so there's no need to sync often.
  - There is also a background sync every `SIMPLEFIN_SYNC_INTERVAL_HOURS` (default 6).
- **Changes from the bank:** corrections update unmatched lines. Lines you've already matched are never changed.
- **Problems:** errors SimpleFIN reports (for example, a bank that needs you to sign in again at the Bridge) are shown on
  the connection. If the access is revoked, remove the connection and add a new setup token.
- **Remove** deletes the connection and its stored access URL. Lines already imported stay in the bank feed. To revoke
  access completely, also delete the app's connection at the SimpleFIN Bridge.
- **Security:**
  - Access URLs are encrypted with AES-256-GCM using `ENCRYPTION_KEY`.
  - Setup tokens and access URLs must use https and point at an allowed SimpleFIN server (`SIMPLEFIN_ALLOWED_HOSTS`),
    so a pasted token can't make the server call other addresses. Redirects aren't followed.
  - Connections are private to their organization; only organization administrators can add, change or remove them.

**Setup (server)**

| Variable | Value |
| --- | --- |
| `ENCRYPTION_KEY` | Required. A long random string used to encrypt access URLs (and other stored secrets). Don't change it later, or stored connections can't be read |
| `SIMPLEFIN_ALLOWED_HOSTS` | Optional, comma-separated. Default `bridge.simplefin.org,beta-bridge.simplefin.org` |
| `SIMPLEFIN_SYNC_INTERVAL_HOURS` | Optional, default `6` |

For testing, the SimpleFIN Bridge offers a demo setup token in its developer documentation.

**Moving from Stripe Financial Connections:** Stripe is no longer used.
- Lines Stripe already imported stay in the bank feed.
- The old `fc_accounts` table is left in place but unused.
- Disconnect the accounts in the Stripe Dashboard so Stripe stops billing for them, and remove the `STRIPE_*` variables.
- Reconnect the banks here with Connect bank.

## API and MCP server

Programs and AI assistants can use The Faithful Steward **with a user's own sign-in**. A token acts as its user: the
same organizations, roles and permissions as their web sign-in, checked on every request by the same code. Anything the
user can't do in the web app, they can't do through the API or MCP either, and the app's rules (closed periods,
reconciled totals, validation) still apply. Changes are recorded as made by that user.

**Signing in (OAuth 2.1)**
- MCP clients and other apps use the standard OAuth flow with PKCE (S256). They discover it from
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, register themselves at
  `/oauth/register`, and send the user to `/oauth/authorize`. The user signs in with their normal user name and
  password and approves the app (**Allow / Deny**), and the app exchanges the one-time code at `/oauth/token`.
- Scripts can sign in directly: `POST /oauth/token` with `grant_type=password&username=…&password=…`. Failed attempts
  are throttled like the web sign-in.
- Access tokens last 1 hour; refresh tokens 30 days and are replaced each time they're used (reusing an old one ends
  that sign-in). Revoke a token at `/oauth/revoke`. Only hashes of codes and tokens are stored (`oauth_tokens`).
- **My account & connected apps** (user menu) lists the apps connected with your sign-in, with **Disconnect**.
  Changing your password ends your other sign-ins; an administrator resetting it, deactivating the user or removing
  them from an organization ends or limits access straight away. Users who must change their password can't use tokens
  until they do.
- **API and MCP access** is **off** for every user until an organization administrator turns it on (**User Setup** →
  edit the user → **API and MCP access**). Users with it on show an *API / MCP* badge. Without it, a user can't sign in
  through the API, approve apps or get tokens; turning it off ends their existing API and MCP sign-ins straight away.
  Their web sign-in isn't affected.

**REST API:** the app's own JSON API at `/api/…`, with `Authorization: Bearer <access token>`.
- If the user belongs to more than one organization, add `X-Organization-Id: <id>` (`GET /api/auth/me` lists them);
  with only one, it's used automatically.
- Lists page with `?page=N` (500 rows) and sort with `?sort=…&dir=asc|desc`, as described under Lists.
- Examples: `GET /api/lookups` (accounts, funds, names), `GET /api/expenses?page=1&from=2026-01-01`,
  `POST /api/income`, `POST /api/journal-entries`, `GET /api/register?accountId=…`, `POST /api/reports/run`.

**MCP server:** `https://<your-domain>/mcp` (Streamable HTTP). Add it as a custom connector / remote MCP server in
Claude or another assistant; it asks you to sign in and approve. Tools:

| Look up | Change |
| --- | --- |
| `list_organizations`, `get_chart_of_accounts`, `find_customers_vendors`, `list_transactions`, `get_transaction`, `bank_register`, `list_reports`, `run_report`, `list_bank_feed` | `create_customer_vendor`, `create_income`, `create_expense`, `create_journal_entry`, `create_transfer`, `assign_bank_feed_line`, `quick_add_bank_feed_line`, `match_bank_feed_line` |

Accounts, funds and names can be given by id, exact name or account number. Each tool takes an optional
`organization_id`. The tools call the REST API as the user, so they follow exactly the same permissions.

Set `PUBLIC_URL` (e.g. `https://books.example.org`) if the app is reached through an address the server can't see
itself; otherwise the discovery documents use the address requests arrive on.

## Running locally

Requires Node.js 20+ and a PostgreSQL server. If you don't have PostgreSQL, the dev script can run a temporary one:

```bash
npm install
npm install --no-save embedded-postgres   # only needed for the throwaway local database
npm run dev:db                            # terminal 1: Postgres on localhost:5433
npm run seed:demo                         # optional: demo org; sign in as demo / demo-password
npm run build && npm start                # terminal 2: http://localhost:3000
```

On first start, if there's no system administrator, one is created from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. If
`ADMIN_PASSWORD` isn't set, a random temporary password is printed to the log. For front-end hot reload, run `npm run dev`
(API) and `npm run dev:client` (Vite on :5173, which proxies `/api`).

Tests (integration, against a real database; they create and drop `npacct_test`):

```bash
npm test
```

## Deploying to Railway

1. Create a Railway project and add a **PostgreSQL** database.
2. Add a service from this repository. `railway.json` sets the build (`npm run build`), start (`npm start`) and health check (`/api/health`).
3. Set these service variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET` = a long random string
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` = the first system administrator
   - `NODE_ENV` = `production`
   - Optional: `ANTHROPIC_MODEL` (each organization adds its own Claude API key in its settings; see Attachments) and the SimpleFIN variables described above
4. Deploy. Migrations run automatically on startup, guarded by an advisory lock. Sign in, open **Manage organizations**
   (user menu), create your organization, and add users under **User Setup**.

## Project layout

```
server/
  index.js              Express app, sessions, security headers, static hosting
  migrations/           SQL migrations (run on startup)
  services/ledger.js    Income/expense/deposit/reconciliation saving + GL posting
  services/reports.js   Report engine (rows, formulas, columns, drill-down)
  services/simplefin.js  SimpleFIN setup tokens, encrypted access URLs, transaction sync
  services/builtinReports.js  Standard report definitions
  routes/               REST API
client/src/
  pages/                Screens (TxnEdit, DepositEdit, ReconcileEdit, BankFeed, ReportView, ReportDesigner, ...)
  components/           Shared UI (searchable combo boxes, modals, report table)
scripts/                dev database + demo data
test/                   API integration tests
```
