# 测试用的样本文件

这些文件是用真实的软件生成的，用来检查“从文档里取出文字”这一步（`test/attachments.test.js`）。
内容都是编的，可以随便改；改了以后记得同步更新测试里期望的文字。

| 文件 | 怎么来的 | 用来测什么 |
| --- | --- | --- |
| `report.docx` | python-docx 写出来，再用 LibreOffice 另存一遍 | 标题、制表符、列表、表格、中英文混排 |
| `sales.xlsx` | openpyxl 写出来，再用 LibreOffice 另存一遍 | 两个工作表、日期、公式算好的值、布尔值、空单元格 |
| `roadmap.pptx` | python-pptx（用的是 PowerPoint 自带的模板） | 两页幻灯片，第二页有表格 |
| `report-libreoffice.pdf` | LibreOffice 把 `report.docx` 导出成 PDF | 内嵌的字体子集，文字要靠 ToUnicode 表还原 |
| `notes-chrome.pdf` | Chromium 把一个网页打印成 PDF | 中文字体、弯引号、表格、每个词单独定位 |
| `review-reportlab.pdf` | ReportLab | 标准字体（没有内嵌）、两页、表格 |
| `scan.pdf` | ReportLab 把一张图片放满整页 | 扫描件：取不出文字，要把文件本身交给 AI |
| `locked.pdf` | pypdf 加密（AES-128，打开要密码） | 加密的 PDF：取不出文字 |

其他格式的文件（图片、zip、各种损坏的文档）体积很小，由 `test/files.js` 在测试时现做。
