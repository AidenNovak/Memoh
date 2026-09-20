import Foundation

/**
 聊天正文的 Markdown：**解析层**（Foundation-only）。
 视觉那一半在 `MarkdownText.swift`（UIKit）。

 ## 为什么是自己写的子集解析器
 仓库不引第三方 Swift 依赖；CommonMark 全量（HTML、引用式链接、嵌套容器、4 空格缩进代码）
 对着聊天正文是过度工程。这里只覆盖模型真的会写、用户真的要看的东西，**没做的部分写清楚**
 （支持清单与"不做"的理由见 `docs/CHAT-RENDERING.md`）。

 ## 流式友好：半截的语法不许闪成原始符号
 这是本层最重要的判据。以前"渲染"直接把源文本塞进 `UILabel`，于是 `**bo` 就显示成 `**bo`。
 现在先解析成 span 再渲染，解析器对**还没写完的语法**做保守合并（`tolerant`）：

 - 半截的强调 / 删除线 / 行内代码：吞掉定界符，把剩下的当作**已开始的样式内容**
   （`**bo` → 粗体 `bo`；`` `co `` → 行内代码 `co`）；
 - 半截的围栏代码块：整块当代码（CommonMark 也是"未闭合围栏在文末闭合"）；
 - 半截的块级标记（单独一行的 `#` / `-` / `1.` / `>` / `|` / ```` ``` ````）：这一行**什么都不画**；
 - 半截的链接 `[label](ht`：只画链接文字（链接样式），不画 `[` `]` `(` `)`。

 `tolerant` **只作用于正文的最后一行**，而且只在这条消息还在流（`streaming`）时才打开。
 流结束、读历史消息时是**严格模式**：不成对的定界符按字面文本画——那时候 `**` 真的是
 用户能看见的字符，把它藏起来才是骗人。

 ## 增量：每个 token 只重解析最后一个块
 `updated(with:)` 在"新文本以旧文本为前缀"（流式追加的常态）时复用所有**在旧文本最后一行
 之前就结束**的块，只从最后一个块的起始行重新解析。`parsedCharacters` 是这次真的重解析了
 多少字符——它是**断言的对象**，不是感觉（`testIncrementalParsingOnlyReparsesTheTail`）。
 */
struct MarkdownInlineStyle: OptionSet, Hashable, Sendable {
  let rawValue: Int
  init(rawValue: Int) { self.rawValue = rawValue }

  static let bold = MarkdownInlineStyle(rawValue: 1 << 0)
  static let italic = MarkdownInlineStyle(rawValue: 1 << 1)
  static let strikethrough = MarkdownInlineStyle(rawValue: 1 << 2)
  static let code = MarkdownInlineStyle(rawValue: 1 << 3)
  static let link = MarkdownInlineStyle(rawValue: 1 << 4)
}

/// 一段**已经解析过**的行内内容。渲染层只认这个，不再看原始字符。
struct MarkdownSpan: Hashable, Sendable {
  var text: String
  var style: MarkdownInlineStyle
  /// 链接目标（`style` 含 `.link` 时才可能非空）。流式里可能是半截 URL。
  var destination: String?

  init(_ text: String, _ style: MarkdownInlineStyle = [], destination: String? = nil) {
    self.text = text
    self.style = style
    self.destination = destination
  }
}

enum MarkdownBlockKind: Hashable, Sendable {
  case heading(level: Int)
  case paragraph
  case bullet(depth: Int)
  case ordered(index: Int, depth: Int)
  case quote(depth: Int)
  case rule
  /// 围栏代码块。`language` 是信息串（可能为空；不做语法高亮）。
  case code(language: String?)
  /**
   `| a | b |` 这类表格行。

   **不做表格布局**（列宽、对齐、表头分隔线是完整一套排版系统，本轮不做）。按**等宽块**
   呈现：保留原文的管道与空格，可以横向滚。这样至少列是对齐的、能读；比原样吐一堆
   管道加分隔线好，也比半吊子表格（列宽乱跳）好。判据：模型写表格时用户能看懂。
   */
  case table
}

struct MarkdownBlock: Hashable, Sendable {
  var kind: MarkdownBlockKind
  var spans: [MarkdownSpan]
  /// 代码块/表格的**逐行原文**（保留缩进，渲染成等宽、可横滚的块）。
  var lines: [String]
  /// 这个块覆盖的源文本行区间（半开）。增量解析据此复用。
  var lineRange: Range<Int>

  var text: String { spans.map(\.text).joined() }
}

struct MarkdownDocument: Sendable {
  private(set) var blocks: [MarkdownBlock]
  private(set) var lines: [String]
  private(set) var text: String
  /// **本次**解析真正读了多少个字符。增量复用的度量（断言用它）。
  private(set) var parsedCharacters: Int
  /// 本次沿用了上一次解析结果的前多少个块（渲染层据此复用属性字符串）。
  private(set) var reusedBlocks: Int

  /// 严格模式（历史消息、已结束的消息）下解析。
  static func parse(_ text: String) -> MarkdownDocument {
    parse(text, tolerantLastLine: false)
  }

  /**
   一个**不做 Markdown 解析**的文档：整段就是一段纯文本。

   给用户气泡用。用户敲的是他要发出去的原文，把 `*`、`_` 当语法吃掉是改用户的话
   （`snake_case`、`2*3` 在他的输入里是字面意思）。但它与助手正文共用同一套块视图、
   复制与无障碍路径——只有"解析"这一步不同。
   */
  static func literal(_ text: String) -> MarkdownDocument {
    let lines = normalizedLines(text)
    let blocks: [MarkdownBlock]
    if text.isEmpty {
      blocks = []
    } else {
      blocks = [MarkdownBlock(kind: .paragraph, spans: [MarkdownSpan(text)], lines: [],
                              lineRange: 0..<max(lines.count, 1))]
    }
    return MarkdownDocument(blocks: blocks, lines: lines, text: text,
                            parsedCharacters: text.count, reusedBlocks: 0)
  }

  /**
   解析入口。

   `tolerantLastLine`：最后一行可能还在长（流式），对它启用"半截语法"的保守合并。
   */
  static func parse(_ text: String, tolerantLastLine: Bool) -> MarkdownDocument {
    let lines = normalizedLines(text)
    let last = lines.isEmpty ? nil : lines.count - 1
    let blocks = parseBlocks(in: lines[...], offset: 0,
                             tolerantLine: tolerantLastLine ? last : nil)
    return MarkdownDocument(blocks: blocks, lines: lines, text: text,
                            parsedCharacters: text.count, reusedBlocks: 0)
  }

  /**
   追加式更新：新文本以旧文本为前缀时，只重解析**最后一个块**。

   为什么"只重解析最后一个块"就够（这是本层唯一一处需要证明的地方）：

   1. 前缀相同蕴含"除最后一行外，逐行相同"——追加只可能改动最后一行、或在它后面加行。
      所以**不需要**逐行比较（逐行比较是 O(整条消息)，正是这里要拿掉的东西）。
   2. 重解析只从"最后一个原块的起始行"开始：一个块可能被追加**延续**（段落续行、列表项
      续行、还没闭合的围栏代码块），所以最后一块不能复用；它之前的块都结束在更早的行上，
      追加碰不到它们。

   代价说清楚：一个"整条消息就是一个段落"的极端形状里，单价仍是 O(该段)——行内语法可以
   跨行（定界符从上一行开到下一行），段内必须整段扫。能保证的是**不是** O(整条消息)。
   `parsedCharacters` 是这次真的读了多少字符，断言用它，不靠感觉。
   */
  func updated(with newText: String, tolerantLastLine: Bool) -> MarkdownDocument {
    guard !text.isEmpty, newText.hasPrefix(text) else {
      return MarkdownDocument.parse(newText, tolerantLastLine: tolerantLastLine)
    }
    let newLines = Self.normalizedLines(newText)
    guard newLines.count >= lines.count else {
      return MarkdownDocument.parse(newText, tolerantLastLine: tolerantLastLine)
    }
    let lastIndex = newLines.count - 1
    let stable = max(blocks.count - 1, 0)
    let tailStart = blocks.isEmpty ? 0 : min(blocks[stable].lineRange.lowerBound, lastIndex)
    let tail = Self.parseBlocks(in: newLines[tailStart...], offset: tailStart,
                                tolerantLine: tolerantLastLine ? lastIndex : nil)
    let reparsed = newLines[tailStart...].reduce(0) { $0 + $1.count }
    return MarkdownDocument(blocks: Array(blocks.prefix(stable)) + tail, lines: newLines,
                            text: newText, parsedCharacters: reparsed, reusedBlocks: stable)
  }

  // MARK: - 给用户看的文本

  /**
   屏幕上**真正画出来的文字**（不含复制用的排版标记：列表符号、`> `、`---`）。

   它就是渲染层送进 `UILabel` 的那些 span 的拼接，因此可以拿来断言"半截的 Markdown 没有
   闪成原始符号"——这条断言的对象是用户看得见的东西，不是中间数据结构
   （`testStreamingPrefixesNeverShowRawMarkdown`）。
   */
  var renderedText: String {
    blocks.map { block in
      switch block.kind {
      case .code, .table:
        return block.lines.joined(separator: "\n")
      case .rule:
        return ""
      case .heading, .paragraph, .bullet, .ordered, .quote:
        return block.text
      }
    }.joined(separator: "\n")
  }

  /// 复制用的纯文本：**渲染后**的文本（去掉 `**`、`#`，列表带项目符号）。
  var plainText: String {
    blocks.map { block in
      switch block.kind {
      case .heading, .paragraph:
        return block.text
      case .bullet(let depth):
        return String(repeating: "  ", count: depth) + "• " + block.text
      case .ordered(let index, let depth):
        return String(repeating: "  ", count: depth) + "\(index). " + block.text
      case .quote:
        return block.text.split(separator: "\n", omittingEmptySubsequences: false)
          .map { "> " + $0 }.joined(separator: "\n")
      case .rule:
        return "---"
      case .code, .table:
        return block.lines.joined(separator: "\n")
      }
    }.joined(separator: "\n\n")
  }

  /**
   读屏用的文本：是**句子**，不是符号。

   与 `plainText` 的差别只有两处，都有理由：列表不念项目符号（`•` 与 `1.` 是排版，
   不是内容；VoiceOver 念出来是噪声），分隔线不念（没有可听的内容）。
   */
  var accessibilityText: String {
    blocks.compactMap { block -> String? in
      switch block.kind {
      case .rule:
        return nil
      case .code, .table:
        return block.lines.joined(separator: "\n")
      case .heading, .paragraph, .bullet, .ordered, .quote:
        let text = block.text
        return text.isEmpty ? nil : text
      }
    }.joined(separator: ". ")
  }

  /// 文档里出现的链接（按出现顺序、去重）。给"读屏的动作"与点击命中用。
  var links: [(text: String, destination: String)] {
    var result: [(String, String)] = []
    for block in blocks {
      for span in block.spans where span.style.contains(.link) {
        guard let destination = span.destination, !destination.isEmpty else { continue }
        guard !result.contains(where: { $0.1 == destination }) else { continue }
        result.append((span.text, destination))
      }
    }
    return result
  }

  // MARK: - 行

  static func normalizedLines(_ text: String) -> [String] {
    text.components(separatedBy: CharacterSet.newlines)
  }

  // MARK: - 块级

  private enum LineKind {
    case blank
    case fenceOpen(Character, Int, String)
    case heading(Int, String)
    case rule
    case quote(String)
    case bullet(text: String, indent: Int)
    case ordered(index: Int, text: String, indent: Int)
    case tableRow
    case incompleteMarker
    case paragraph
  }

  private static func parseBlocks(in lines: ArraySlice<String>, offset: Int,
                                  tolerantLine: Int?) -> [MarkdownBlock] {
    var result: [MarkdownBlock] = []
    var index = lines.startIndex
    let end = lines.endIndex
    var paragraphSpans: [MarkdownSpan] = []
    var paragraphStart = index
    var paragraphEnd = index
    var inParagraph = false

    func absolute(_ i: Int) -> Int { offset + (i - lines.startIndex) }
    func tolerant(_ i: Int) -> Bool { tolerantLine == absolute(i) }

    func flushParagraph() {
      guard inParagraph, !paragraphSpans.isEmpty else {
        paragraphSpans = []
        inParagraph = false
        return
      }
      result.append(MarkdownBlock(kind: .paragraph, spans: paragraphSpans, lines: [],
                                  lineRange: paragraphStart..<paragraphEnd))
      paragraphSpans = []
      inParagraph = false
    }

    func listItem(at i: Int) -> (kind: MarkdownBlockKind, text: String)? {
      switch classify(lines[i], tolerant: tolerant(i)) {
      case .bullet(let text, let indent):
        return (.bullet(depth: indentDepth(indent)), text)
      case .ordered(let number, let text, let indent):
        return (.ordered(index: number, depth: indentDepth(indent)), text)
      default:
        return nil
      }
    }

    while index < end {
      switch classify(lines[index], tolerant: tolerant(index)) {
      case .blank:
        flushParagraph()
        index += 1

      case .fenceOpen(let character, let count, let info):
        flushParagraph()
        let start = index
        var body: [String] = []
        index += 1
        while index < end {
          if isClosingFence(lines[index], character: character, minimum: count) {
            index += 1
            break
          }
          // 正在打的收尾围栏（````` ` ``/`` ``` `` 还没到三个）：它**不是**代码正文，
          // 不然用户会看到反引号一闪。只对文档最后一行这么判。
          if tolerantLine != nil, index == end - 1, !lines[index].isEmpty,
             lines[index].allSatisfy({ $0 == character }) {
            break
          }
          body.append(lines[index])
          index += 1
        }
        result.append(MarkdownBlock(kind: .code(language: info.isEmpty ? nil : info), spans: [],
                                    lines: body, lineRange: start..<index))

      case .heading(let level, let text):
        flushParagraph()
        let start = index
        result.append(MarkdownBlock(kind: .heading(level: level),
                                    spans: inlineSpans(text, tolerant: tolerant(index)), lines: [],
                                    lineRange: start..<(start + 1)))
        index += 1

      case .rule:
        flushParagraph()
        result.append(MarkdownBlock(kind: .rule, spans: [], lines: [], lineRange: index..<(index + 1)))
        index += 1

      case .quote:
        flushParagraph()
        let start = index
        var spans: [MarkdownSpan] = []
        while index < end, case .quote(let more) = classify(lines[index], tolerant: tolerant(index)) {
          if !spans.isEmpty { spans.append(MarkdownSpan("\n")) }
          spans.append(contentsOf: inlineSpans(more, tolerant: tolerant(index)))
          index += 1
        }
        result.append(MarkdownBlock(kind: .quote(depth: 0), spans: spans, lines: [],
                                    lineRange: start..<index))

      case .bullet, .ordered:
        flushParagraph()
        while index < end, let item = listItem(at: index) {
          let start = index
          var text = item.text
          index += 1
          // 续行：缩进 ≥2 且本身不是新的块标记 → 属于这一项。
          while index < end, isListContinuation(lines[index]) {
            text += "\n" + lines[index].trimmingCharacters(in: .whitespaces)
            index += 1
          }
          guard !text.isEmpty else { continue }
          result.append(MarkdownBlock(kind: item.kind,
                                      spans: inlineSpans(text, tolerant: tolerant(start)), lines: [],
                                      lineRange: start..<index))
        }

      case .tableRow:
        flushParagraph()
        let start = index
        var body: [String] = []
        while index < end, isTableLine(lines[index]) {
          body.append(lines[index])
          index += 1
        }
        result.append(MarkdownBlock(kind: .table, spans: [], lines: body, lineRange: start..<index))

      case .incompleteMarker:
        // 半截的块级标记（`#`、`-`、`1.`、`>`、`|`…）：这一行什么都不画。
        flushParagraph()
        index += 1

      case .paragraph:
        if !inParagraph {
          inParagraph = true
          paragraphStart = index
          paragraphSpans = []
        } else {
          paragraphSpans.append(MarkdownSpan("\n"))
        }
        paragraphSpans.append(contentsOf: inlineSpans(lines[index], tolerant: tolerant(index)))
        paragraphEnd = index + 1
        index += 1
      }
    }
    flushParagraph()
    return result
  }

  private static func classify(_ line: String, tolerant: Bool) -> LineKind {
    let trimmed = String(line.drop(while: { $0 == " " || $0 == "\t" }))
    if trimmed.isEmpty { return .blank }
    let indent = line.count - trimmed.count
    if indent <= 3 {
      if let fence = openingFence(trimmed) { return .fenceOpen(fence.0, fence.1, fence.2) }
      if let heading = headingLine(trimmed) { return .heading(heading.0, heading.1) }
      if isRule(trimmed) { return .rule }
      if trimmed.first == ">" {
        return .quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
      }
      if let item = listItemLine(trimmed) {
        switch item {
        case .bullet(let text, _): return .bullet(text: text, indent: indent)
        case .ordered(let number, let text, _): return .ordered(index: number, text: text, indent: indent)
        default: break
        }
      }
    }
    if trimmed.first == "|" {
      // 半截的表格行：一根管子。两根以上就可能是一行真表格了，按等宽块画。
      if tolerant, trimmed.filter({ $0 == "|" }).count < 2 { return .incompleteMarker }
      return .tableRow
    }
    if tolerant, isIncompleteMarker(trimmed) { return .incompleteMarker }
    return .paragraph
  }

  private static func indentDepth(_ indent: Int) -> Int { min(indent / 2, 2) }

  private static func openingFence(_ line: String) -> (Character, Int, String)? {
    guard let first = line.first, first == "`" || first == "~" else { return nil }
    let run = line.prefix { $0 == first }.count
    guard run >= 3 else { return nil }
    let info = String(line.dropFirst(run)).trimmingCharacters(in: .whitespaces)
    if first == "`", info.contains("`") { return nil }
    return (first, run, info)
  }

  private static func isClosingFence(_ line: String, character: Character, minimum: Int) -> Bool {
    let trimmed = line.drop(while: { $0 == " " })
    guard trimmed.first == character else { return false }
    let run = trimmed.prefix { $0 == character }.count
    guard run >= minimum else { return false }
    return trimmed.dropFirst(run).allSatisfy { $0 == " " || $0 == "\t" }
  }

  private static func headingLine(_ line: String) -> (Int, String)? {
    guard line.first == "#" else { return nil }
    let level = line.prefix { $0 == "#" }.count
    guard level <= 6 else { return nil }
    let rest = line.dropFirst(level)
    if rest.isEmpty { return (level, "") }
    guard rest.first == " " || rest.first == "\t" else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    // 收尾的 `#` 序列是装饰：`## 标题 ##`
    let closing = text.reversed().prefix { $0 == "#" }.count
    if closing > 0 {
      let cut = text.index(text.endIndex, offsetBy: -closing)
      let head = text[..<cut]
      if head.isEmpty || head.hasSuffix(" ") {
        text = head.trimmingCharacters(in: .whitespaces)
      }
    }
    return (level, text)
  }

  private static func isRule(_ line: String) -> Bool {
    let stripped = line.filter { $0 != " " && $0 != "\t" }
    guard stripped.count >= 3, let first = stripped.first,
          first == "-" || first == "*" || first == "_" else { return false }
    return stripped.allSatisfy { $0 == first }
  }

  private static func listItemLine(_ line: String) -> LineKind? {
    guard let first = line.first else { return nil }
    if first == "-" || first == "*" || first == "+" {
      let rest = line.dropFirst()
      guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
      return .bullet(text: rest.trimmingCharacters(in: .whitespaces), indent: 0)
    }
    let digits = line.prefix { $0.isNumber }.count
    guard digits >= 1, digits <= 9 else { return nil }
    let afterDigits = line.dropFirst(digits)
    guard let delimiter = afterDigits.first, delimiter == "." || delimiter == ")" else { return nil }
    let rest = afterDigits.dropFirst()
    guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
    let number = Int(line.prefix(digits)) ?? 1
    return .ordered(index: number, text: rest.trimmingCharacters(in: .whitespaces), indent: 0)
  }

  /**
   单独一行、还看不出是什么的标记。

   ⚠️ 只对**数字**放宽到 3 位：`1`、`12` 可能是还没写完的 `1.` / `12.`；但 `2026` 更可能是
   一个年份，把它吞掉会让用户看到"打了一半的年突然消失"。
   */
  private static func isIncompleteMarker(_ line: String) -> Bool {
    let marks: Set<String> = ["#", "##", "###", "####", "#####", "######",
                              "-", "*", "+", ">", "```", "~~~", "|"]
    if marks.contains(line) { return true }
    if line.count <= 3, line.allSatisfy({ $0.isNumber }) { return true }
    if line.count <= 4, let last = line.last, last == "." || last == ")",
       line.dropLast().allSatisfy({ $0.isNumber }), !line.dropLast().isEmpty {
      return true
    }
    // 半截的表格行：一根管子（两根以上就可能是一行真表格了，按等宽块画）
    if line.first == "|", line.filter({ $0 == "|" }).count < 2 { return true }
    return false
  }

  private static func isListContinuation(_ line: String) -> Bool {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
    let indent = line.count - line.drop(while: { $0 == " " || $0 == "\t" }).count
    guard indent >= 2 else { return false }
    if case .paragraph = classify(line, tolerant: false) { return true }
    return false
  }

  private static func isTableLine(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.first == "|" { return true }
    return isTableDelimiter(trimmed)
  }

  private static func isTableDelimiter(_ line: String) -> Bool {
    guard line.contains("|"), line.contains("-") else { return false }
    return line.allSatisfy { $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " || $0 == "\t" }
  }

  // MARK: - 行内

  /**
   行内解析。`tolerant` 为真时，**未闭合**的定界符吞掉自己、把剩下的当已开始的样式。

   规则与理由见文件头。这里只强调一件事：`tolerant` 不在这里判断它是不是最后一行——
   调用方（块解析器）只对最后一行传 `true`。
   */
  static func inlineSpans(_ source: String, style: MarkdownInlineStyle = [],
                          link: String? = nil, tolerant: Bool = false) -> [MarkdownSpan] {
    guard !source.isEmpty else { return [] }
    let characters = Array(source)
    let count = characters.count
    var spans: [MarkdownSpan] = []
    var buffer = ""

    func flush() {
      guard !buffer.isEmpty else { return }
      spans.append(MarkdownSpan(buffer, style, destination: link))
      buffer = ""
    }

    func emit(_ text: String, _ extra: MarkdownInlineStyle, destination: String? = nil) {
      guard !text.isEmpty else { return }
      flush()
      spans.append(MarkdownSpan(text, style.union(extra), destination: destination ?? link))
    }

    /// 递归解析一段**闭合**的样式内容（闭合 = 内容已经完整，内层用严格模式）。
    func emitNested(_ text: String, _ extra: MarkdownInlineStyle, tolerant inner: Bool) {
      guard !text.isEmpty else { return }
      flush()
      spans.append(contentsOf: inlineSpans(text, style: style.union(extra), link: link,
                                           tolerant: inner))
    }

    var i = 0
    while i < count {
      let character = characters[i]

      if character == "\\", i + 1 < count, isEscapable(characters[i + 1]) {
        buffer.append(characters[i + 1])
        i += 2
        continue
      }

      if character == "`", !style.contains(.code) {
        let run = runLength(characters, at: i, of: "`")
        if let close = closingRun(characters, from: i + run, character: "`", length: run,
                                  requirePrecedingNonSpace: false) {
          let content = String(characters[(i + run)..<close])
          emit(content.isEmpty ? " " : content, .code)
          i = close + run
          continue
        }
        if tolerant {
          let rest = String(characters[(i + run)...])
          emit(rest, .code)
          i = count
          continue
        }
        buffer.append(contentsOf: characters[i..<(i + run)])
        i += run
        continue
      }

      if (character == "!" && i + 1 < count && characters[i + 1] == "[")
        || character == "[" {
        let bracket = character == "!" ? i + 1 : i
        if let found = linkTarget(characters, bracket: bracket, tolerant: tolerant) {
          // 图片（`![alt](url)`）不下载：仓库纪律里原生侧不拉远端资源。画成"指向它的链接"，
          // 文字是 alt——用户至少能看到有个东西在那儿，并且点得开。
          flush()
          spans.append(contentsOf: inlineSpans(found.text, style: style.union(.link),
                                               link: found.destination.isEmpty ? nil : found.destination,
                                               tolerant: false))
          i = found.end
          continue
        }
        if character == "!" {
          buffer.append(character)
          i += 1
          continue
        }
      }

      if character == "<", !style.contains(.code), let found = autolink(characters, at: i) {
        emit(found.text, .link, destination: found.destination)
        i = found.end
        continue
      }

      if !style.contains(.code), isURLStart(characters, at: i), let found = bareURL(characters, at: i) {
        emit(found.text, .link, destination: found.destination)
        i = found.end
        continue
      }

      if character == "~", i + 1 < count, characters[i + 1] == "~", !style.contains(.code) {
        if let close = closingRun(characters, from: i + 2, character: "~", length: 2) {
          emitNested(String(characters[(i + 2)..<close]), .strikethrough, tolerant: false)
          i = close + 2
          continue
        }
        if tolerant {
          // 行尾的 `~~` 还没写完：不画符号。
          if i + 2 >= count { i = count; continue }
          emitNested(String(characters[(i + 2)...]), .strikethrough, tolerant: true)
          i = count
          continue
        }
        buffer.append(contentsOf: characters[i..<(i + 2)])
        i += 2
        continue
      }

      if (character == "*" || character == "_"), !style.contains(.code) {
        let run = min(runLength(characters, at: i, of: character), 3)
        let extra = emphasisStyle(run: run)
        if tolerant, i + run >= count, !style.contains(.code) {
          // 行尾的定界符：内容还没来，符号先到了。什么都不画。
          i = count
          continue
        }
        if isLeftFlanking(characters, at: i, run: run, character: character),
           let close = closingRun(characters, from: i + run, character: character, length: run,
                                  requirePrecedingNonSpace: true) {
          emitNested(String(characters[(i + run)..<close]), extra, tolerant: false)
          i = close + run
          continue
        }
        if tolerant, isLeftFlanking(characters, at: i, run: run, character: character) {
          // 行尾的定界符（`**`）还没有内容：什么都不画。
          if i + run >= count { i = count; continue }
          emitNested(String(characters[(i + run)...]), extra, tolerant: true)
          i = count
          continue
        }
        buffer.append(contentsOf: characters[i..<(i + run)])
        i += run
        continue
      }

      buffer.append(character)
      i += 1
    }
    flush()
    return spans
  }

  private static func emphasisStyle(run: Int) -> MarkdownInlineStyle {
    if run >= 3 { return [.bold, .italic] }
    return run == 2 ? .bold : .italic
  }

  private static func isEscapable(_ character: Character) -> Bool {
    "\\`*_{}[]()#+-.!>~|\"'".contains(character)
  }

  private static func isSpace(_ character: Character) -> Bool {
    character == " " || character == "\t" || character == "\n"
  }

  private static func isWordCharacter(_ character: Character) -> Bool {
    character.isLetter || character.isNumber
  }

  private static func runLength(_ characters: [Character], at index: Int, of character: Character) -> Int {
    var length = 0
    while index + length < characters.count, characters[index + length] == character { length += 1 }
    return length
  }

  private static func closingRun(_ characters: [Character], from: Int, character: Character,
                                 length: Int, requirePrecedingNonSpace: Bool = true) -> Int? {
    var index = from
    while index < characters.count {
      if characters[index] == character, runLength(characters, at: index, of: character) == length {
        if !requirePrecedingNonSpace || (index > 0 && !isSpace(characters[index - 1])) {
          if character != "_" || index + length >= characters.count
            || !isWordCharacter(characters[index + length]) {
            return index
          }
        }
      }
      index += 1
    }
    return nil
  }

  private static func isLeftFlanking(_ characters: [Character], at index: Int, run: Int,
                                     character: Character) -> Bool {
    let after = index + run
    guard after < characters.count, !isSpace(characters[after]) else { return false }
    // `snake_case` 里的下划线不是强调：开定界符左边必须是词边界。
    if character == "_", index > 0, isWordCharacter(characters[index - 1]) { return false }
    return true
  }

  private static func linkTarget(_ characters: [Character], bracket: Int,
                                 tolerant: Bool) -> (text: String, destination: String, end: Int)? {
    var index = bracket + 1
    while index < characters.count, characters[index] != "]" { index += 1 }
    guard index < characters.count else { return nil }
    let text = String(characters[(bracket + 1)..<index])
    guard index + 1 < characters.count, characters[index + 1] == "(" else {
      // `[文字]` 右边还没有括号：流式中间态只画文字，不画方括号。
      if tolerant, index + 1 >= characters.count { return (text, "", characters.count) }
      return nil
    }
    var cursor = index + 2
    while cursor < characters.count, characters[cursor] != ")" { cursor += 1 }
    let destination = String(characters[(index + 2)..<min(cursor, characters.count)])
    return (text, destination, cursor < characters.count ? cursor + 1 : characters.count)
  }

  private static func autolink(_ characters: [Character], at index: Int)
    -> (text: String, destination: String, end: Int)? {
    var cursor = index + 1
    while cursor < characters.count, characters[cursor] != ">", !isSpace(characters[cursor]) { cursor += 1 }
    guard cursor < characters.count, characters[cursor] == ">" else { return nil }
    let inside = String(characters[(index + 1)..<cursor])
    guard isURLStart(Array(inside), at: 0) || (inside.contains("@") && inside.contains(".")) else {
      return nil
    }
    let destination = inside.contains("@") && !isURLStart(Array(inside), at: 0) ? "mailto:\(inside)" : inside
    return (inside, destination, cursor + 1)
  }

  private static func isURLStart(_ characters: [Character], at index: Int) -> Bool {
    guard index < characters.count, characters[index] == "h" else { return false }
    if index > 0, isWordCharacter(characters[index - 1]) { return false }
    let rest = characters[index...]
    return hasPrefix(rest, "http://") || hasPrefix(rest, "https://")
  }

  /// `ArraySlice<Character>` 的前缀比较（不建字符串：这条路径每个字符都会被问一次）。
  private static func hasPrefix(_ characters: ArraySlice<Character>, _ text: String) -> Bool {
    var index = characters.startIndex
    for character in text {
      guard index < characters.endIndex, characters[index] == character else { return false }
      index += 1
    }
    return true
  }

  private static func bareURL(_ characters: [Character], at index: Int)
    -> (text: String, destination: String, end: Int)? {
    var cursor = index
    let terminators: Set<Character> = [" ", "\t", "\n", "<", ">", "\"", "'", "`"]
    while cursor < characters.count, !terminators.contains(characters[cursor]) { cursor += 1 }
    var text = String(characters[index..<cursor])
    // 收尾的标点不属于 URL：`见 https://a.com。` / `(https://a.com)`
    let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "。", "，", "、", "；", "：", "！", "？"]
    while let last = text.last, trailing.contains(last) { text.removeLast() }
    while text.hasSuffix(")"), text.filter({ $0 == "(" }).count < text.filter({ $0 == ")" }).count {
      text.removeLast()
    }
    guard let url = URL(string: text), url.host != nil else { return nil }
    return (text, text, index + text.count)
  }
}

/**
 链接能不能开——**白名单**。

 只认 http / https / mailto：模型输出里的 `file://`、`shortcuts://` 之类不能被当成一个
 "点一下就执行"的入口。这不是洁癖——远程内容能决定我们调起什么 URL，白名单是这一层唯一
 守得住的边界。

 放在 Foundation 层，因为判据全是字符串规则（scheme 白名单与不完整 URL），与 UIKit
 无关。
 */
enum MarkdownLinkPolicy {
  static func openableURL(_ destination: String) -> URL? {
    let trimmed = destination.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return nil }
    guard ["http", "https", "mailto"].contains(scheme) else { return nil }
    if scheme != "mailto", url.host?.isEmpty != false { return nil }
    return url
  }
}
