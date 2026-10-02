# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman ファミリー**。同じ作者、同じオーケストレーション指針：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植版）· **dsh-switchman**（本リポジトリ、DeepSeek Harness 版）。

![dsh-switchman — コンテキスト水位が転轍士を動かし、タスクを正しいレーンへ投げ込む](docs/assets/hero.svg)

> コンテキストに水量計を付けると、タスクは自分でレーンを見つけます。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用のプラグインです。導入すると、メインモデルは「何もかも自分でこなす」役を降りてディスパッチャーになります：水位を測り、レーンを選び、タスクを配り、仕上がりを確認する。やることは 4 つです：

**1. コンテキスト水位制御。** 毎ラウンドでセッション token をリアルタイム計測します。soft（デフォルト 50k）は委譲を勧め、hard（90k）はラウンドごとの読み取り予算を引き締めてまとめに入るよう促し、force（130k）はセッションを自動バックアップして圧縮へ引き渡します。セッションを一日中回しても、コンテキストが自分の履歴で溺れることはありません。委譲された各サブエージェントは独立したハード上限を持ち、超えたら HANDOFF 要約を書いて退場します。

**2. 6 レーンのディスパッチ。** economy / mechanical / main / hard / vision / review の 6 つの認知レーン：設定ページで候補モデルを選び、最強優先でランク付けし（S/A/B/C ティアのアンカーは任意）、ルートごとに思考強度をピン留めできます——ドロップダウンのレベル一覧は各モデルが*実際に*対応しているものから直接来るもので、汎用の三段階ではありません。`[SWITCHMAN:POOLS]` 推奨表がプロンプトとともに主モデルへ渡され、主モデルはそれに従って仕事を振ります。`enforce` モードではプール外モデルを即座に拒否します。

**3. 言語設定。** 返信・コードコメント・ドキュメントの 3 種類に、それぞれドロップダウンを一つ。未設定なら初回に一度だけ尋ねて永久に記憶し、以後のすべてのセッションが自動で従います。

**4. デフォルト委譲のドクトリン。** DSH 出荷時の保守的なチーム方針（「頼まれたときだけチームメイトを作る」）を置き換えます：些細な作業は自分で手を動かし（読み <200 行、変更 <50 行）、大きな仕事はデフォルトで委譲。変更は必ず検証されます——20 行超は tester へ、300 行超またはコアロジックに触れる変更は reviewer へ。「チームを使うな」と一言言えば、即座に身を引きます。

モデルが一つだけ？それでも導入する価値があります——水位制御とドクトリンは、モデルの数など気にしません。

## 同梱スキル

- **db-query** — MySQL / Redis 読み取り専用検証：SQL を回してレコード照合、キャッシュキー / TTL 確認、ストア横断の整合性チェックを行い、書き込みは一切拒否します。初回使用時に初期化が必要（下記参照）。
- **git-commit-message** — 規範に沿った commit 文面を生成。テキストだけ出力し、git は一切触りません。
- **requirement-docs** — 要件分析 / PRD / 設計ドキュメントの統一規範。成果物は `docs/requirements-and-design/` にアーカイブします。

## クイックスタート

1. **インストール** — 任意のセッションでエージェントに実行させるか、Web プラグイン管理ページから：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   またはローカルチェックアウトから（link 方式。更新取り込み後は `remove_bundle` + `install_bundle` で再インストール）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   ターミナルから `dsh` CLI でもインストールできます——DSH の実行形態に合わせてプロファイルを選んでください:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # デスクトップアプリ
   ```

2. **DSH を再起動** — アプリを完全に終了して開き直します（ページ再読み込みでは不十分）。クライアントモジュールのテーブルがこの bundle を取り込めるようになります。

3. **設定ページを開く** — 設定 → dsh-switchman。最初の画面は言語設定です：まずスコープを選択——プロファイル全体、またはプロジェクトごと（各プロジェクトの `.switchman/lang.json`）——その後、返信 / コメント / ドキュメントそれぞれのドロップダウンで設定し、各項目の下に「現在: …」のステータス行が付きます。設定しなくても大丈夫——初回に一度だけ尋ねられて記憶されます（尋ねる言語は DSH の UI 言語に従います）。

   ![設定ページと言語設定](docs/assets/conf-demo1.png)

4. **六つのプールを埋める** — 各プールカードにはプロバイダー別にグループ化された候補モデルが並びます。欲しいものにチェック。**手動順**にチェックすると、カードは ↑ ↓ × 操作付きの番号付き優先リストになります。選択した各ルートの横にある思考強度ドロップダウンの初期値は「レーンに従う」で、ピン留めすればそのモデルが実際に対応するレベル（Low / High / Max…）が選べます。サマリー行が進捗をリアルタイムに反映します：「プール設定 6/6 · ランク付け 3 件 · モード アドバイス」。

   ![ディスパッチプールの設定](docs/assets/conf-demo2.png)

5. **能力ランクと水位** — ランキング表の番号はそのまま能力順（最強が先）で、S/A/B/C ティアのアンカーは任意。実行モードは三態です：`off` / アドバイス / enforce（enforce = プール外モデルは即拒否）。その下の水位セクションは token 使用量に応じて段階的に挙動を引き締めます：三段階のしきい値、1 回あたりの読み取り予算、hard モードの挙動（制限付き通過 / 遮断）、自動ハンドオーバー切替、サブエージェント独立上限。最下部にはコマンド行があります：`/ctx-pause` 介入を一時停止 · `/ctx-resume` 再開 · `/ctx-handover` 即時バックアップして引き継ぎ。

   ![能力ランクとコンテキスト水位](docs/assets/conf-demo3.png)

6. **検証** — どのセッションでもヘッダーのプリセット chip の横に ⚡ バッジが表示されます。モデルに「システムプロンプトの最後のセクションには何が書かれていますか」と尋ねてみてください。dsh-switchman のドクトリンに言及するはずです。

**db-query の初回セットアップ**（スクリプトの依存関係はスキルディレクトリ内に置かれます）：

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## 仕組み

- Host 側（`index.js` + `host/`）は、動的システムプロンプトセクション 3 つ、読み取り予算と enforce の二重ゲート、回答の自動キャプチャ、スラッシュコマンド 3 つを注入します。設定はすべて volatile フィールドで、保存すれば次のプロンプト組み立てから反映され、再起動は不要です。
- Client 側（`client.js`）はプリセット chip の横の ⚡ バッジと設定ページを描画します。公式の settings-form サービス経由です。
- `cordis.patch.yml` は出荷時プリセットのプラグインリストをフィールド単位でそのまま写し、persona suffix だけを拡張します。Agent Teams ツール本体は引き続き出荷時の `@deepseek-ai/dsh-experimental-agent-team-profile` から供給されます。

## メンテナンス

- DSH のアップグレード後、出荷時プリセットのプラグインリストが変わっていたら、新しい `presets/*.patch.yml` から `cordis.patch.yml` を再同期し（doctrine suffix は維持）、再インストールします。
- プロトコル行（`[SWITCHMAN:LANG|POOLS|WATERMARK]`）は意図的に英語・バイト安定を保っています——ローカライズしないでください。
- `npm pack --dry-run` は監査済みの 34 ファイル / ~111 kB の形を維持する必要があります（`docs/` のスクリーンショットはパッケージに入りません）。

## License

MIT
