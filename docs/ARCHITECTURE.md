# Vitta Vriksha Architecture & System Design

This document details the architectural layers, data flows, state machines, and cryptographic boundaries of Vitta Vriksha. For detailed sub-system diagrams and feature flowcharts, see [FUNCTIONAL_FLOWS.md](./FUNCTIONAL_FLOWS.md).

---

## 1. System Topology

```mermaid
graph TD
    subgraph Native Shell [Android Native Layer (Kotlin)]
        MainActivity[MainActivity]
        WebAppInterface[WebAppInterface]
        Biometrics[BiometricHelper]
        Alarms[ReminderReceiver & AlarmManager]
        Alerts[SmsReceiver & NotificationListener]
        Queue[AlertQueue (SharedPreferences)]
    end

    subgraph Web Layer [Assets/WWW (ES Modules + WASM)]
        AppRouter[app.js (Router & State Controller)]
        Bridge[bridge.js (Bridge & Dispatcher)]
        Views[views/ (Home, Ledger, Investments, Tax, etc.)]
        BackendRouter[backend/index.js]
        SQLiteWASM[backend/database.js + sqlite.wasm]
        WebCrypto[backend/vault.js + crypto.js]
        Parsers[vendor/casparser.js + pdf.js + broker_parser.js]
    end

    MainActivity -->|Hosts WebView| AppRouter
    Views -->|Bridge.db / Bridge.call| Bridge
    Bridge -->|Calls JS Backend| BackendRouter
    Bridge -->|Calls AndroidBridge| WebAppInterface
    BackendRouter --> SQLiteWASM
    BackendRouter --> WebCrypto
    BackendRouter --> Parsers
    Alerts -->|looksFinancial Filter| Queue
    WebAppInterface -->|takePendingAlerts| Queue
    WebAppInterface --> Biometrics
    WebAppInterface --> Alarms
```

---

## 2. Vault & Cryptographic State Machine

The entire SQLite database file is encrypted on disk using AES-256-GCM. The user PIN is never stored or compared in cleartext.

```mermaid
stateDiagram-v2
    [*] --> CheckVault: App Launch
    CheckVault --> Uninitialized: No Vault Key
    CheckVault --> Locked: Vault Key Found (Locked)
    CheckVault --> Unlocked: Key in Memory

    Uninitialized --> SetupScreen: Render Setup
    SetupScreen --> CreatingVault: User Sets Master PIN
    CreatingVault --> Unlocked: Generate 32B Data Key + PBKDF2 Wrap

    Locked --> LockScreen: Render Lock Screen
    LockScreen --> Verifying: User Enters PIN / Biometrics
    Verifying --> Unlocked: PBKDF2 Unwrap Success
    Verifying --> Locked: Wrong PIN (Exponential Delay)

    Unlocked --> Running: Load Settings & Views
    Running --> Locked: Screen Off / Timeout / User Locks
    Locked --> [*]
```

---

## 3. Financial SMS & Notification Ingestion Pipeline

Incoming bank messages are captured in the background without waking the JavaScript engine, ensuring high battery efficiency.

```mermaid
sequenceDiagram
    participant OS as Android OS
    participant Receiver as SmsReceiver / NotificationListener
    participant Queue as AlertQueue
    participant Bridge as WebAppInterface
    participant Classifier as sms.js (Batch Classifier)
    participant DB as database.js (SQLite WASM)

    OS->>Receiver: Incoming SMS / Notification
    Receiver->>Receiver: Coarse looksFinancial Filter
    Receiver->>Queue: Enqueue Raw Message
    Receiver->>OS: Show "X Transactions to Review" Notification
    Note over OS,Queue: App is Opened by User
    Bridge->>Queue: takePendingAlerts()
    Queue-->>Bridge: Drained Alerts JSON Array
    Bridge->>Classifier: classify_batch(alerts, rulesContext)
    Classifier->>Classifier: Extract Amount, Date, Type, Merchant, Account
    Classifier-->>Bridge: Structured Draft Transactions
    Bridge->>DB: save_transaction (Auto-link Cards & Accounts)
```

---

## 4. Statutory FIFO Capital Gains & Tax Engine Flow

Complies with Section 111A, Section 112A (with Jan 31, 2018 Grandfathering), Section 50AA (Debt), and Budget 2024 (July 23, 2024 Regime Split).

```mermaid
graph TD
    Holdings[MF Folios + Stock Trades + CAS Imports] --> Sorter[Sort by Trade Date ASC]
    Sorter --> SecurityBucket[Group by Security ISIN / Symbol]
    SecurityBucket --> FIFOMatcher[tax_engine.js: FIFO Buy/Sell Matcher]
    FIFOMatcher --> HoldingPeriod[Classify STCG vs LTCG based on Asset Class]
    HoldingPeriod --> Section112A[Apply Jan 31, 2018 FMV Grandfathering if Pre-2018]
    Section112A --> RegimeSplit[Budget 2024 Cutoff: Before/After July 23, 2024]
    RegimeSplit --> OutputReports[Tax Reports, Advance Tax Q1-Q5, Schedule 112A CSV]
    HoldingPeriod --> OpenLots[Active Lots Maturity Tracker & Tax Harvesting Engine]
```

---

## 5. Security Invariants

1. **Zero Cleartext Credentials**: PIN is PBKDF2-derived with random salt.
2. **Deterministic Foreign Key Integrity**: Backups are written and restored in strict topological dependency order (`family_members` -> `asset_accounts` -> `credit_cards` -> `transactions` -> `splits`/`cashbacks`).
3. **No Unbounded Memory Growth**: In-memory reference caches (`isinNameCache`, `navCache`, `directIsinCache`) and AlertQueue (bounded at 200 items) protect against device memory pressure.
4. **Timezone-Safe Financial Dates**: All business dates and calendar math use local calendar parsers (`parseISO`, `isoDate`, `today()`) rather than UTC `.toISOString()`.

