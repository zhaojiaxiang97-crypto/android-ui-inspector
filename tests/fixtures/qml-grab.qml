import QtQuick
import QtQuick.Window

Window {
    id: scene
    width: 200
    height: 110
    visible: true
    color: "transparent"

    Rectangle {
        id: parentItem
        x: 10
        y: 10
        width: 100
        height: 80
        color: "red"
        clip: true

        Rectangle {
            id: childItem
            x: 20
            y: 15
            width: 40
            height: 30
            color: "blue"
        }

        Rectangle { x: 85; y: 50; width: 30; height: 20; color: "green" }
        Text { id: textItem; x: 5; y: 55; text: "child"; color: "white" }
    }

    Rectangle {
        id: alphaParent
        x: 130
        y: 10
        width: 50
        height: 50
        color: "red"
        opacity: 0.5
        Rectangle { x: 10; y: 10; width: 20; height: 20; color: "blue"; opacity: 0.5 }
    }

    Timer {
        interval: 250
        running: true
        onTriggered: {
            const output = "/tmp/uiinspector-qml-" + Date.now()
            console.log("capture prefix:", output)
            parentItem.grabToImage(function(group) {
                if (!group.saveToFile(output + "-group.png")) console.error("group save failed")
                childItem.grabToImage(function(leaf) {
                    if (!leaf.saveToFile(output + "-leaf.png")) console.error("leaf save failed")
                    textItem.grabToImage(function(textLeaf) {
                        if (!textLeaf.saveToFile(output + "-text.png")) console.error("text save failed")
                        alphaParent.grabToImage(function(alphaGroup) {
                            if (!alphaGroup.saveToFile(output + "-alpha.png")) console.error("alpha save failed")
                            Qt.quit()
                        })
                    })
                })
            })
        }
    }
}
